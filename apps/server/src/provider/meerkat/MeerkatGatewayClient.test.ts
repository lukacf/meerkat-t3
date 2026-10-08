import { afterEach, describe, expect, it } from "vite-plus/test";
import * as Cause from "effect/Cause";

import { ProviderAdapterRequestError } from "../Errors.ts";

import {
  createMeerkatGatewayClient,
  type MeerkatGatewayClient,
  type MeerkatGatewayEvent,
  MeerkatGatewayRpcError,
  MeerkatGatewayTransportError,
} from "./MeerkatGatewayClient.ts";

const clients: Array<MeerkatGatewayClient> = [];
const expectedCloseFailures = new Map<MeerkatGatewayClient, string>();
const fixture = String.raw`
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
const write = (frame) => process.stdout.write(JSON.stringify(frame) + "\n");
const result = (id, value) => write({ jsonrpc: "2.0", id, result: value });
let held;
let holdCount = 0;
const writing = new Set();
let writingCancelled = 0;
lines.on("line", (line) => {
  const request = JSON.parse(line);
  switch (request.method) {
    case "text.v1.generate":
      writing.add(request.id);
      break;
    case "text.v1.cancel":
      if (writing.delete(request.params.requestId)) {
        writingCancelled++;
        write({jsonrpc:"2.0",id:request.params.requestId,error:{code:-32800,message:"Writing request cancelled",data:{code:"REQUEST_CANCELLED",trace_id:"cancel"}}});
      }
      result(request.id, {status:"cancel_requested"});
      break;
    case "writingState": result(request.id, {active:writing.size,cancelled:writingCancelled}); break;
    case "hold": {
      holdCount += 1;
      held = request;
      write({ jsonrpc: "2.0", method: "events.v1.emit", params: {
        event_id: "accepted", kind: "run.started", timestamp: "2026-09-25T12:00:00Z",
        thread_id: "thread-1", run_id: "run-1", trace_id: "trace-1", payload: { model: "test" }
      }});
      break;
    }
    case "release":
      result(request.id, "second-response-first");
      if (held) result(held.id, "first-response-second");
      break;
    case "count": result(request.id, holdCount); break;
    case "error": write({ jsonrpc: "2.0", id: request.id, error: {
      code: -32009, message: "Thread already has an active mob run", data: {
        code: "CONFLICT", trace_id: "trace-error", details: { runId: "run-1" }
      }
    }}); break;
    case "structuredError": write({ jsonrpc: "2.0", id: request.id, error: {
      code: -32000, message: "Failed to create MobKit mob", data: {
        code: "POLICY_ERROR", trace_id: "trace-native", details: request.params
      }
    }}); break;
    case "fragment": {
      const bytes = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: "Hi 🦦" }) + "\n");
      const split = bytes.indexOf(Buffer.from("🦦")) + 1;
      process.stdout.write(bytes.subarray(0, split));
      setImmediate(() => process.stdout.write(bytes.subarray(split)));
      break;
    }
    case "invalid": process.stdout.write("not JSON\n"); break;
    case "oversized": process.stdout.write("x".repeat(1025)); break;
    case "exit": process.exit(request.params.code ?? 17); break;
    case "shutdownFailure":
      write({jsonrpc:"2.0",method:"system.v1.shutdownComplete",params:request.params});
      process.stdout.end(() => process.exit(1));
      break;
    default: result(request.id, request.params);
  }
});
lines.on("close", () => write({jsonrpc:"2.0",method:"system.v1.shutdownComplete",params:{cleanupCompleted:true}}));
`;

function makeClient(options: { maxFrameBytes?: number } = {}) {
  const client = createMeerkatGatewayClient({
    binaryPath: process.execPath,
    args: ["--input-type=module", "-e", fixture],
    ...options,
  });
  clients.push(client);
  return client;
}

function makeShutdownClient(receipts: ReadonlyArray<unknown>, exitCode = 0) {
  const client = createMeerkatGatewayClient({
    binaryPath: process.execPath,
    args: [
      "--input-type=module",
      "-e",
      String.raw`
        import { createInterface } from "node:readline";
        const lines = createInterface({ input: process.stdin });
        const write = frame => process.stdout.write(JSON.stringify(frame) + "\n");
        lines.on("line", line => write({jsonrpc:"2.0",id:JSON.parse(line).id,result:{ready:true}}));
        lines.on("close", () => {
          for (const params of ${JSON.stringify(receipts)}) write({jsonrpc:"2.0",method:"system.v1.shutdownComplete",params});
          process.exitCode = ${exitCode};
        });
      `,
    ],
  });
  clients.push(client);
  return client;
}

function nextEvent(client: MeerkatGatewayClient): Promise<MeerkatGatewayEvent> {
  return new Promise((resolve) => {
    const unsubscribe = client.subscribe((event) => {
      unsubscribe();
      resolve(event);
    });
  });
}

afterEach(async () => {
  try {
    await Promise.all(
      clients.splice(0).map(async (client) => {
        const expectedKind = expectedCloseFailures.get(client);
        if (expectedKind)
          await expect(client.close()).rejects.toMatchObject({ kind: expectedKind });
        else await client.close();
      }),
    );
  } finally {
    expectedCloseFailures.clear();
  }
});

describe("MeerkatGatewayClient", () => {
  it("retains sanitized native shutdown provenance on an unexpected exit", async () => {
    const client = makeClient();
    expectedCloseFailures.set(client, "process_exited");
    await expect(client.request("shutdownFailure", {
      cleanupCompleted: true,
      trigger: {kind: "stdin_error", errorKind: "WouldBlock", rawOsError: 35, message: "/private/prompt"},
      errors: ["private provider output"],
    })).rejects.toMatchObject({
      kind: "process_exited",
      details: {cleanupCompleted: true, trigger: {kind: "stdin_error", errorKind: "WouldBlock", rawOsError: 35}},
    });
    const error = await client.request("never-replayed").catch((error: unknown) => error);
    expect(JSON.stringify(error)).not.toContain("private");
  });

  it("does not retain arbitrary native diagnostic text as a shutdown trigger", async () => {
    const client = makeClient();
    expectedCloseFailures.set(client, "cleanup_failed");
    await expect(client.request("shutdownFailure", {
      cleanupCompleted: false,
      trigger: {kind: "stdin_error", errorKind: "/private/prompt", rawOsError: "secret"},
    })).rejects.toMatchObject({
      kind: "process_exited",
      details: {cleanupCompleted: false, trigger: {kind: "stdin_error"}},
    });
  });

  it("correlates interleaved responses while preserving runtime events", async () => {
    const client = makeClient();
    const event = nextEvent(client);
    const first = client.request("hold");
    expect(await event).toMatchObject({
      event_id: "accepted",
      kind: "run.started",
      thread_id: "thread-1",
      run_id: "run-1",
      payload: { model: "test" },
    });
    const second = client.request("release");
    expect(await second).toBe("second-response-first");
    expect(await first).toBe("first-response-second");
  });

  it("reassembles UTF-8 characters split between stdout chunks", async () => {
    const client = makeClient();
    expect(await client.request("fragment")).toBe("Hi 🦦");
  });

  it("retains the gateway typed code, trace, and recovery details", async () => {
    const client = makeClient();
    const error = await client.request("error").catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(MeerkatGatewayRpcError);
    expect(error).toMatchObject({
      rpcCode: -32009,
      typedCode: "CONFLICT",
      traceId: "trace-error",
      details: { runId: "run-1" },
    });
    expect(error).not.toHaveProperty("cause");
    expect(await client.request("echo", { stillConnected: true })).toEqual({
      stillConnected: true,
    });
  });

  it("retains the native error string through the adapter cause without rendering other details", async () => {
    const client = makeClient();
    const details = {
      error: "failed to open mob storage: /private/workflow/mob.sqlite is locked",
      configuration: "DO_NOT_RENDER_CONFIGURATION",
    };
    const error = await client.request("structuredError", details).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(MeerkatGatewayRpcError);
    expect(error).toMatchObject({
      name: "MeerkatGatewayRpcError",
      message: "Failed to create MobKit mob",
      rpcCode: -32000,
      typedCode: "POLICY_ERROR",
      traceId: "trace-native",
      details,
      cause: new Error(details.error),
    });
    const wrapped = new ProviderAdapterRequestError({
      provider: "meerkat",
      method: "mobs.v1.createThreadMob",
      detail: "Failed to create MobKit mob",
      cause: error,
    });
    expect(wrapped.cause).toBe(error);
    const rendered = Cause.pretty(Cause.fail(wrapped));
    expect(rendered).toContain(details.error);
    expect(rendered).not.toContain(details.configuration);
  });

  it.each([undefined, null, "unstructured", [], { error: { message: "nested" } }, { error: "" }])(
    "does not invent a cause for unsupported details %j",
    (details) => {
      const error = new MeerkatGatewayRpcError({
        message: "Native request failed",
        rpcCode: -32000,
        typedCode: "POLICY_ERROR",
        details,
      });
      expect(error.message).toBe("Native request failed");
      expect(error.details).toBe(details);
      expect(error).not.toHaveProperty("cause");
    },
  );

  it.each([0, 17])(
    "rejects sent requests with unknown outcome on exit %i and never relabels it clean disposal",
    async (code) => {
      const client = makeClient();
      expectedCloseFailures.set(client, "process_exited");
      const connectionFailure = new Promise<MeerkatGatewayTransportError>((resolve) =>
        client.onClose(resolve),
      );
      const event = nextEvent(client);
      const held = expect(client.request("hold")).rejects.toMatchObject({
        kind: "process_exited",
        outcomeUnknown: true,
      });
      await event;
      const exited = expect(client.request("exit", { code })).rejects.toMatchObject({
        kind: "process_exited",
        outcomeUnknown: true,
      });
      await Promise.all([held, exited]);
      await expect(client.request("count")).rejects.toMatchObject({ kind: "process_exited" });
      const failure = await connectionFailure;
      const closed = client.close();
      await expect(closed).rejects.toBe(failure);
      expect(client.close()).toBe(closed);
      await expect(client.close()).rejects.toBe(failure);
    },
  );

  it("aborts waiting without claiming cancellation or retrying the turn", async () => {
    const client = makeClient();
    const controller = new AbortController();
    const event = nextEvent(client);
    const held = expect(
      client.request("hold", {}, { signal: controller.signal }),
    ).rejects.toMatchObject({ kind: "request_aborted", outcomeUnknown: true });
    await event;
    controller.abort();
    await held;
    expect(await client.request("count")).toBe(1);
    expect(await client.request("release")).toBe("second-response-first");
    expect(await client.request("echo", { afterLateResponse: true })).toEqual({
      afterLateResponse: true,
    });
  });

  it("does not send already aborted or oversized requests", async () => {
    const client = makeClient();
    const controller = new AbortController();
    controller.abort();
    await expect(client.request("hold", {}, { signal: controller.signal })).rejects.toMatchObject({
      kind: "request_aborted",
      outcomeUnknown: false,
    });
    await expect(client.request("hold", { text: "x".repeat(256 * 1024) })).rejects.toMatchObject({
      kind: "invalid_request",
      outcomeUnknown: false,
    });
    expect(await client.request("count")).toBe(0);
  });

  it("cancels only an interrupted writing request and keeps agent work connected", async () => {
    const client = makeClient();
    const controller = new AbortController();
    const accepted = nextEvent(client);
    const agent = client.request("hold");
    await accepted;
    const first = expect(
      client.request("text.v1.generate", {}, { signal: controller.signal }),
    ).rejects.toMatchObject({ kind: "request_aborted" });
    const secondController = new AbortController();
    const second = expect(
      client.request("text.v1.generate", {}, { signal: secondController.signal }),
    ).rejects.toMatchObject({ kind: "request_aborted" });
    expect(await client.request("writingState")).toEqual({ active: 2, cancelled: 0 });
    controller.abort();
    await first;
    expect(await client.request("writingState")).toEqual({ active: 1, cancelled: 1 });
    expect(await client.request("release")).toBe("second-response-first");
    await expect(agent).resolves.toBe("first-response-second");
    secondController.abort();
    await second;
    expect(await client.request("writingState")).toEqual({ active: 0, cancelled: 2 });
  });

  it("cancels writing on timeout and provider close without claiming agent cancellation", async () => {
    const client = makeClient();
    await expect(client.request("text.v1.generate", {}, { timeoutMs: 20 })).rejects.toMatchObject({
      kind: "request_timeout",
    });
    expect(await client.request("writingState")).toEqual({ active: 0, cancelled: 1 });
    const writing = expect(client.request("text.v1.generate")).rejects.toMatchObject({
      typedCode: "REQUEST_CANCELLED",
    });
    expect(await client.request("writingState")).toEqual({ active: 1, cancelled: 1 });
    await client.close();
    await writing;
  });

  it("allows bounded image upload frames while rejecting oversized images before dispatch", async () => {
    const client = makeClient();
    const dataBase64 = "x".repeat(300 * 1024);
    expect(await client.request("mobs.v1.imageUpload", { dataBase64 })).toEqual({ dataBase64 });
    await expect(
      client.request("mobs.v1.imageUpload", { dataBase64: "x".repeat(14 * 1024 * 1024) }),
    ).rejects.toMatchObject({ kind: "invalid_request", outcomeUnknown: false });
    expect(await client.request("echo", { alive: true })).toEqual({ alive: true });
  });

  it.each(["invalid", "oversized"])("fails closed on %s output", async (method) => {
    const client = makeClient({ maxFrameBytes: 1024 });
    expectedCloseFailures.set(client, "protocol_error");
    const connectionFailure = new Promise<MeerkatGatewayTransportError>((resolve) =>
      client.onClose(resolve),
    );
    await expect(client.request(method)).rejects.toMatchObject({
      kind: "protocol_error",
      outcomeUnknown: true,
    });
    await expect(client.request("echo")).rejects.toMatchObject({ kind: "protocol_error" });
    const failure = await connectionFailure;
    await expect(client.close()).rejects.toBe(failure);
    await expect(client.close()).rejects.toBe(failure);
  });

  it("reports an unavailable binary while allowing disposal of the never-started process", async () => {
    const client = createMeerkatGatewayClient({ binaryPath: "/missing/meerkat-gateway-test" });
    clients.push(client);
    await expect(client.request("system.v1.health")).rejects.toMatchObject({
      kind: "spawn_failed",
    });
    expect(client.pid).toBeUndefined();
    const closed = client.close();
    await expect(closed).resolves.toBeUndefined();
    expect(client.close()).toBe(closed);
    await expect(client.request("system.v1.health")).rejects.toMatchObject({
      kind: "spawn_failed",
    });
  });

  it("closes only its owned subprocess and rejects requests sent after close", async () => {
    const client = makeClient();
    const sibling = makeClient();
    expect(await client.request("echo", { ready: true })).toEqual({ ready: true });
    await client.close();
    await expect(client.request("echo")).rejects.toMatchObject({ kind: "closed" });
    expect(await sibling.request("echo", { ready: true })).toEqual({ ready: true });
    await client.close();
  });

  it("drains an admitted response past the former one-second kill deadline", async () => {
    const client = createMeerkatGatewayClient({
      binaryPath: process.execPath,
      args: [
        "--input-type=module",
        "-e",
        String.raw`
        import { createInterface } from "node:readline";
        const lines = createInterface({ input: process.stdin });
        const write = frame => process.stdout.write(JSON.stringify(frame) + "\n");
        let pending;
        lines.on("line", line => {
          pending = JSON.parse(line);
          write({jsonrpc:"2.0",method:"events.v1.emit",params:{event_id:"accepted",kind:"run.started",timestamp:"2026-09-28T12:00:00Z",trace_id:"test",payload:{}}});
        });
        lines.on("close", () => setTimeout(() => {
          write({jsonrpc:"2.0",id:pending.id,result:{drained:true}});
          write({jsonrpc:"2.0",method:"system.v1.shutdownComplete",params:{cleanupCompleted:true}});
        }, 1250));
      `,
      ],
      shutdownTimeoutMs: 4_000,
    });
    clients.push(client);
    const admitted = nextEvent(client);
    const work = client.request("hold");
    await admitted;
    const closed = client.close();
    await expect(work).resolves.toEqual({ drained: true });
    await closed;
  });

  it("requires a native cleanup receipt even when the process exits successfully", async () => {
    const client = makeShutdownClient([]);
    expectedCloseFailures.set(client, "cleanup_failed");
    await client.request("ready");
    await expect(client.close()).rejects.toMatchObject({
      kind: "cleanup_failed",
      outcomeUnknown: false,
      message: "Meerkat exited without confirming native cleanup.",
    });
  });

  it("requires a clean process exit even after a positive native cleanup receipt", async () => {
    const client = makeShutdownClient([{ cleanupCompleted: true }], 17);
    expectedCloseFailures.set(client, "cleanup_failed");
    await client.request("ready");
    await expect(client.close()).rejects.toMatchObject({
      kind: "cleanup_failed",
      outcomeUnknown: false,
    });
  });

  it("shares successful cleanup across concurrent and repeated closes", async () => {
    const client = makeShutdownClient([{ cleanupCompleted: true, errors: [] }]);
    await client.request("ready");
    const first = client.close();
    const concurrent = client.close();
    expect(concurrent).toBe(first);
    await Promise.all([first, concurrent]);
    expect(client.close()).toBe(first);
    await expect(client.close()).resolves.toBeUndefined();
  });

  it("retains the first negative receipt and exact error across concurrent and repeated closes", async () => {
    const details = {
      cleanupCompleted: false,
      errors: ["native drain failed"],
      source: { identity: "coordinator" },
    };
    const client = makeShutdownClient([
      details,
      { cleanupCompleted: false, errors: ["later error"] },
      { cleanupCompleted: true },
    ]);
    expectedCloseFailures.set(client, "cleanup_failed");
    const sibling = makeClient();
    await client.request("ready");
    const first = client.close();
    const concurrent = client.close();
    expect(concurrent).toBe(first);
    const error = await first.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(MeerkatGatewayTransportError);
    expect(error).toMatchObject({ kind: "cleanup_failed", outcomeUnknown: false, details });
    await expect(concurrent).rejects.toBe(error);
    expect(client.close()).toBe(first);
    await expect(client.close()).rejects.toBe(error);
    expect(await sibling.request("echo", { alive: true })).toEqual({ alive: true });
  });
});
