// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - isolated private loopback fixture.
import { describe, expect, it } from "@effect/vitest";
import { openSharedToolHost } from "./SharedToolHost.ts";

const invocation = {
  version: 1,
  mobId: "native-mob",
  sessionId: "native-session",
  runId: "native-run",
  callId: "call",
  action: "projects.list",
  arguments: {},
};
describe("private native shared tool transport", () => {
  it("requires the process capability, refuses browser origins and admits only advertised actions", async () => {
    const host = await openSharedToolHost();
    let calls = 0;
    try {
      host.install(async (value) => {
        calls++;
        return { content: { caller: value.sessionId } };
      });
      const post = (body: unknown, extra: Record<string, string> = {}) =>
        fetch(host.configuration.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${host.configuration.token}`,
            ...extra,
          },
          body: JSON.stringify(body),
        });
      expect((await post(invocation, { Authorization: "Bearer wrong" })).status).toBe(403);
      expect((await post(invocation, { Origin: "https://untrusted.example" })).status).toBe(403);
      expect((await post({ ...invocation, action: "specialists.retire" })).status).toBe(400);
      expect((await post({ ...invocation, sessionId: undefined })).status).toBe(400);
      expect(calls).toBe(0);
      const accepted = await post(invocation);
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toEqual({ content: { caller: "native-session" } });
      expect(calls).toBe(1);
      expect((await post({ ...invocation, arguments: { text: "x".repeat(100_000) } })).status).toBe(
        413,
      );
      expect(calls).toBe(1);
    } finally {
      await host.close();
    }
  });
  it("is unavailable before handler installation and aborts owned invocations on shutdown", async () => {
    const host = await openSharedToolHost();
    const post = () =>
      fetch(host.configuration.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${host.configuration.token}`,
        },
        body: JSON.stringify(invocation),
      });
    let closed = false;
    try {
      expect((await post()).status).toBe(503);
      const entered = Promise.withResolvers<AbortSignal>();
      host.install(
        (_value, signal) =>
          new Promise((resolve) => {
            entered.resolve(signal);
            signal.addEventListener("abort", () => resolve({ content: "Stopped" }), { once: true });
          }),
      );
      const pending = post().catch(() => undefined);
      const signal = await entered.promise;
      await host.close();
      closed = true;
      expect(signal.aborted).toBe(true);
      await pending;
    } finally {
      if (!closed) await host.close();
    }
  });
});
