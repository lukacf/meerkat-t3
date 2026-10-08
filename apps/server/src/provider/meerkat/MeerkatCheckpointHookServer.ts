// @effect-diagnostics nodeBuiltinImport:off - native foreground hooks use an authenticated loopback HTTP callback.
import * as NodeHttp from "node:http";
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";
import type { MeerkatCheckpointScope } from "./MeerkatCheckpointStore.ts";

export const MeerkatCheckpointHookHint = Schema.Struct({
  projectPath: Schema.String,
  workspace: Schema.String,
  stateRoot: Schema.String,
  mobId: Schema.String,
});
export type MeerkatCheckpointHookHint = typeof MeerkatCheckpointHookHint.Type;
const Invocation = Schema.Struct({
  session_id: Schema.String,
  point: Schema.Literals(["run_started", "run_completed", "run_failed"]),
});
const decodeHint = Schema.decodeUnknownSync(Schema.fromJsonString(MeerkatCheckpointHookHint));
const decodeInvocation = Schema.decodeUnknownSync(Schema.fromJsonString(Invocation));

export interface MeerkatCheckpointHookServerOptions {
  /** Resolve actual native session metadata; headers are hints, never workspace authority. */
  readonly resolve: (
    hint: MeerkatCheckpointHookHint,
    sessionId: string,
  ) => Promise<MeerkatCheckpointScope>;
  readonly begin: (
    scope: MeerkatCheckpointScope,
    options: { replaceActive: true },
  ) => Promise<{ readonly id: string; readonly status: string }>;
  readonly complete: (
    scope: MeerkatCheckpointScope,
    options: { failed: boolean; checkpointId: string },
  ) => Promise<unknown>;
  readonly onError?: (error: unknown) => void;
}

/** Start only with the owning provider instance, and close with that instance's scope. */
export async function createMeerkatCheckpointHookServer(
  options: MeerkatCheckpointHookServerOptions,
) {
  const token = NodeCrypto.randomBytes(32).toString("hex");
  const active = new Map<string, string>();
  const pending = new Map<string, Promise<void>>();
  const ordered = (sessionId: string, run: () => Promise<void>) => {
    const previous = pending.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(run);
    pending.set(sessionId, next);
    void next
      .finally(() => {
        if (pending.get(sessionId) === next) pending.delete(sessionId);
      })
      .catch(() => {});
    return next;
  };
  const expectedAuthorization = Buffer.from(`Bearer ${token}`);
  const callbackPath = `/native-checkpoint/${NodeCrypto.randomBytes(16).toString("hex")}`;
  const server = NodeHttp.createServer({ maxHeaderSize: 16 * 1024 }, (request, response) => {
    const reply = (status: number, body: string) => {
      if (response.writableEnded) return;
      response.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(body);
    };
    const authorization = Buffer.from(request.headers.authorization ?? "");
    if (request.method !== "POST" || request.url !== callbackPath) {
      reply(404, "{}");
      request.resume();
      return;
    }
    if (
      authorization.length !== expectedAuthorization.length ||
      !NodeCrypto.timingSafeEqual(authorization, expectedAuthorization)
    ) {
      reply(401, "{}");
      request.resume();
      return;
    }
    const header = request.headers["x-t3-checkpoint-scope"];
    if (typeof header !== "string" || header.length > 12_000) {
      reply(400, "{}");
      request.resume();
      return;
    }
    void (async () => {
      try {
        const hint = decodeHint(Buffer.from(header, "base64").toString("utf8"));
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const chunk of request) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          length += bytes.length;
          // HookInvocation may include the user's prompt. Consume, but never retain/log it.
          if (length > 4 * 1024 * 1024) {
            reply(413, "{}");
            return;
          }
          chunks.push(bytes);
        }
        const invocation = decodeInvocation(Buffer.concat(chunks).toString("utf8"));
        if (!invocation.session_id) {
          reply(400, "{}");
          return;
        }
        await ordered(invocation.session_id, async () => {
          const scope = await options.resolve(hint, invocation.session_id);
          if (scope.sessionId !== invocation.session_id)
            throw Error("Native checkpoint session changed during scope resolution.");
          if (invocation.point === "run_started") {
            active.delete(invocation.session_id);
            const checkpoint = await options.begin(scope, { replaceActive: true });
            if (checkpoint.status === "active") active.set(invocation.session_id, checkpoint.id);
          } else {
            const checkpointId = active.get(invocation.session_id);
            if (checkpointId) {
              active.delete(invocation.session_id);
              await options.complete(scope, {
                failed: invocation.point === "run_failed",
                checkpointId,
              });
            }
          }
        });
        reply(200, "{}");
      } catch (error) {
        options.onError?.(error);
        // No workspace paths, prompts or native error payloads are reflected to the hook.
        reply(409, "{}");
      }
    })();
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("Native checkpoint callback did not bind to loopback.");
  return {
    url: `http://127.0.0.1:${address.port}${callbackPath}`,
    token,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections();
      }),
  };
}
