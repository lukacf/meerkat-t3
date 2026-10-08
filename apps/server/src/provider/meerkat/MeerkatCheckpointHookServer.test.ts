// @effect-diagnostics nodeBuiltinImport:off - tests use an isolated loopback listener and no models or live state.
import * as NodeHttp from "node:http";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import {
  createMeerkatCheckpointHookServer,
  MeerkatCheckpointHookHint,
} from "./MeerkatCheckpointHookServer.ts";

const hint = { projectPath: "/hint", workspace: "/hint", stateRoot: "/native", mobId: "outer" };
const scope = {
  instanceId: "native",
  projectPath: "/canonical",
  workspace: "/canonical/child",
  mobId: "child",
  sessionId: "session",
  stateRoot: "/native",
};
const encodeHint = Schema.encodeSync(Schema.fromJsonString(MeerkatCheckpointHookHint));
const encodeBody = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
async function post(
  url: string,
  token: string,
  body: string,
  header = Buffer.from(encodeHint(hint)).toString("base64"),
) {
  return await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = NodeHttp.request(
      url,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "x-t3-checkpoint-scope": header,
          "content-type": "application/json",
        },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

describe("native checkpoint callback", () => {
  it("awaits real capture, resolves canonical child scope and carries terminal failure status", async () => {
    const calls: unknown[] = [];
    let release: (() => void) | undefined;
    let began: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    const bridge = await createMeerkatCheckpointHookServer({
      resolve: async (received, sessionId) => {
        calls.push([received, sessionId]);
        return scope;
      },
      begin: async (actual, options) => {
        calls.push([actual, options]);
        began?.();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { id: "checkpoint", status: "active" };
      },
      complete: async (actual, options) => {
        calls.push([actual, options]);
      },
    });
    try {
      let answered = false;
      const response = post(
        bridge.url,
        bridge.token,
        encodeBody({ point: "run_started", session_id: "session", prompt: "not logged" }),
      ).then((value) => {
        answered = true;
        return value;
      });
      await started;
      expect(answered).toBe(false);
      release?.();
      expect(await response).toEqual({ status: 200, body: "{}" });
      expect(calls[1]).toEqual([scope, { replaceActive: true }]);
      expect(
        await post(
          bridge.url,
          bridge.token,
          encodeBody({ point: "run_failed", session_id: "session" }),
        ),
      ).toEqual({ status: 200, body: "{}" });
      expect(calls[3]).toEqual([scope, { failed: true, checkpointId: "checkpoint" }]);
    } finally {
      await bridge.close();
    }
  });
  it("rejects missing authentication, invalid scope, unsupported events and mismatched session without capture", async () => {
    const calls: unknown[] = [];
    const bridge = await createMeerkatCheckpointHookServer({
      resolve: async () => ({ ...scope, sessionId: "wrong" }),
      begin: async () => {
        calls.push("begin");
        return { id: "checkpoint", status: "active" };
      },
      complete: async () => {
        calls.push("complete");
      },
    });
    const payload = encodeBody({ point: "run_started", session_id: "session" });
    try {
      expect((await post(bridge.url, "wrong", payload)).status).toBe(401);
      expect((await post(bridge.url, bridge.token, payload, "invalid")).status).toBe(409);
      expect(
        (
          await post(
            bridge.url,
            bridge.token,
            encodeBody({ point: "pre_tool_execution", session_id: "session" }),
          )
        ).status,
      ).toBe(409);
      expect((await post(bridge.url, bridge.token, payload)).status).toBe(409);
      expect(calls).toEqual([]);
    } finally {
      await bridge.close();
    }
  });
});

it("ignores terminal callbacks without a start on this listener and keeps replacement captures distinct", async () => {
  const completed: Array<{ checkpointId: string; failed: boolean }> = [];
  let next = 0;
  const bridge = await createMeerkatCheckpointHookServer({
    resolve: async () => scope,
    begin: async () => ({ id: `checkpoint-${++next}`, status: "active" }),
    complete: async (_scope, options) => {
      completed.push(options);
    },
  });
  const callback = (point: string) =>
    post(bridge.url, bridge.token, encodeBody({ point, session_id: "session" }));
  try {
    expect((await callback("run_completed")).status).toBe(200);
    expect(completed).toEqual([]);
    await callback("run_started");
    await callback("run_started");
    await callback("run_completed");
    await callback("run_completed");
    expect(completed).toEqual([{ checkpointId: "checkpoint-2", failed: false }]);
  } finally {
    await bridge.close();
  }
});
