// @effect-diagnostics nodeBuiltinImport:off - owns a private, bounded loopback transport for native tools.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import { SharedWorkspaceError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
export const SharedToolInvocation = Schema.Struct({
  version: Schema.Literal(1),
  mobId: Id,
  sessionId: Id,
  runId: Id,
  callId: Id,
  interactionId: Schema.optional(Id),
  action: Id,
  arguments: Schema.Record(Schema.String, Schema.Unknown),
});
export type SharedToolInvocation = typeof SharedToolInvocation.Type;
const decodeToolInvocation = Schema.decodeExit(Schema.fromJsonString(SharedToolInvocation));
export type SharedToolResponse = { readonly content: unknown; readonly isError?: boolean };
export type SharedToolHandler = (
  invocation: SharedToolInvocation,
  signal: AbortSignal,
) => Promise<SharedToolResponse>;
export const sharedToolActions = [
  "projects.list",
  "projects.get",
  "specialists.list",
  "specialists.get",
  "specialists.send",
  "specialists.request",
  "specialists.create",
  "specialists.update",
  "specialists.connect",
  "specialists.split",
  "specialists.consolidate",
  "specialists.supersede",
  "operations.get",
  "inbox.list",
  "inbox.ack",
  "activity.publish",
  "activity.publish_from_inbox",
  "knowledge.search",
  "knowledge.record",
  "knowledge.record_from_inbox",
  "knowledge.supersede",
  "repository.list",
  "repository.read",
  "repository.search",
] as const;
export interface SharedToolHostService {
  readonly configuration: {
    readonly url: string;
    readonly token: string;
    readonly actions: ReadonlyArray<string>;
  };
  readonly install: (handler: SharedToolHandler) => () => void;
}
export class SharedToolHost extends Context.Reference<SharedToolHostService | undefined>(
  "t3/shared/SharedToolHost",
  { defaultValue: () => undefined },
) {}

/** No public route, persisted secret, or user-supplied environment setting. */
export async function openSharedToolHost() {
  const token = NodeCrypto.randomBytes(32).toString("hex");
  const credential = Buffer.from(`Bearer ${token}`);
  const controllers = new Set<AbortController>();
  let handler: SharedToolHandler | undefined;
  const server = NodeHttp.createServer(
    { maxHeaderSize: 8192, headersTimeout: 5000, requestTimeout: 15_000 },
    async (request, response) => {
      const respond = (status: number, value: SharedToolResponse) => {
        if (response.destroyed || response.writableEnded) return;
        const body = JSON.stringify(value);
        if (Buffer.byteLength(body) > 256 * 1024) {
          response.writeHead(413, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          });
          response.end(
            JSON.stringify({
              content: "Tool result exceeds the response limit. Narrow the request.",
              isError: true,
            }),
          );
          return;
        }
        response.writeHead(status, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        response.end(body);
      };
      const supplied = Buffer.from(request.headers.authorization ?? "");
      if (
        request.method !== "POST" ||
        request.url !== "/native-tool" ||
        request.headers.origin ||
        request.headers["content-type"]?.split(";")[0] !== "application/json" ||
        supplied.length !== credential.length ||
        !NodeCrypto.timingSafeEqual(supplied, credential)
      ) {
        request.resume();
        respond(403, {
          content: "This private native tool endpoint refused the request.",
          isError: true,
        });
        return;
      }
      if (!handler || controllers.size >= 16) {
        request.resume();
        respond(503, {
          content:
            "The shared tool host is unavailable. Reconcile any uncertain operation before retrying.",
          isError: true,
        });
        return;
      }
      const activeHandler = handler;
      const controller = new AbortController();
      controllers.add(controller);
      request.setTimeout(65_000, () => {
        controller.abort();
        request.destroy();
      });
      response.on("close", () => {
        if (!response.writableEnded) controller.abort();
      });
      try {
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of request) {
          bytes += Buffer.byteLength(chunk);
          if (bytes > 96 * 1024) {
            respond(413, { content: "Tool request exceeds the size limit.", isError: true });
            return;
          }
          chunks.push(Buffer.from(chunk));
        }
        const decoded = decodeToolInvocation(Buffer.concat(chunks).toString("utf8"));
        if (
          decoded._tag === "Failure" ||
          !sharedToolActions.includes(decoded.value.action as (typeof sharedToolActions)[number])
        ) {
          respond(400, {
            content: "Invalid or unsupported shared tool invocation.",
            isError: true,
          });
          return;
        }
        respond(200, await activeHandler(decoded.value, controller.signal));
      } catch {
        respond(503, {
          content: "Shared tool delivery is uncertain. Reconcile the operation before retrying.",
          isError: true,
        });
      } finally {
        controllers.delete(controller);
      }
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No private shared tool listener.");
  return {
    configuration: {
      url: `http://127.0.0.1:${address.port}/native-tool`,
      token,
      actions: sharedToolActions,
    },
    install(next: SharedToolHandler) {
      if (handler) throw new Error("The shared tool handler already has an owner.");
      handler = next;
      return () => {
        if (handler === next) handler = undefined;
      };
    },
    async close() {
      handler = undefined;
      for (const controller of controllers) controller.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
export const acquireSharedToolHost = Effect.acquireRelease(
  Effect.tryPromise({
    try: openSharedToolHost,
    catch: () =>
      new SharedWorkspaceError({
        code: "unavailable",
        message: "Could not open the private shared tool host.",
      }),
  }),
  (host) => Effect.promise(() => host.close()),
);
