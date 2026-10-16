// @effect-diagnostics nodeBuiltinImport:off - Tests reserve isolated loopback callback ports.
import * as NodeHttp from "node:http";
import type { MeerkatAuthMethod } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { createMeerkatAuthFlows, parseMeerkatAuthCallback } from "./MeerkatAuthFlows.ts";

const deferred = <A>() => {
  let resolve!: (value: A) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<A>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const reserveCallbackPort = async () => {
  const server = NodeHttp.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture callback port");
  return {
    port: address.port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};
const callbackStatus = (url: string) =>
  new Promise<number>((resolve, reject) => {
    NodeHttp.get(url, (response) => {
      response.once("error", reject);
      response.once("end", () => resolve(response.statusCode ?? 0));
      response.resume();
    }).once("error", reject);
  });

describe("Meerkat provider sign-in", () => {
  it("uses the native callback host and path, falling back only to another allowed port", async () => {
    const occupied = await reserveCallbackPort();
    const fallback = await reserveCallbackPort();
    await fallback.close();
    const flows = createMeerkatAuthFlows();
    const expectedRedirect = `http://localhost:${fallback.port}/auth/callback`;
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      expect(params.redirectUri).toBe(expectedRedirect);
      return method === "auth.v1.loginStart"
        ? { authorizeUrl: "https://auth.example/start", state: "native-state" }
        : { connected: true };
    });
    try {
      const flow = await flows.start(
        "owner",
        "scope",
        "openai",
        request,
        {},
        undefined,
        "account",
        async () => ({
          redirectHost: "localhost",
          path: "/auth/callback",
          ports: [occupied.port, fallback.port],
        }),
      );
      const wrongPath = await callbackStatus(
        `http://127.0.0.1:${fallback.port}/oauth/callback?state=native-state&code=wrong-path`,
      );
      expect(wrongPath).toBe(400);
      expect(flows.status(flow.flowId!, "owner", "scope", "openai").status).toBe("waiting");
      expect(request).toHaveBeenCalledTimes(1);
      const response = await callbackStatus(`${expectedRedirect}?state=native-state&code=accepted`);
      expect(response).toBe(200);
      expect(flows.status(flow.flowId!, "owner", "scope", "openai").status).toBe("connected");
      expect(request).toHaveBeenLastCalledWith("auth.v1.loginComplete", {
        provider: "openai",
        redirectUri: expectedRedirect,
        state: "native-state",
        code: "accepted",
      });
    } finally {
      flows.dispose();
      await occupied.close();
    }
  });

  it("fails before native authorization if every permitted callback port is occupied", async () => {
    const first = await reserveCallbackPort();
    const second = await reserveCallbackPort();
    const flows = createMeerkatAuthFlows();
    const request = vi.fn(async () => ({
      authorizeUrl: "https://auth.example/start",
      state: "native-state",
    }));
    try {
      await expect(
        flows.start("owner", "scope", "openai", request, {}, undefined, "account", async () => ({
          redirectHost: "localhost",
          path: "/auth/callback",
          ports: [first.port, second.port],
        })),
      ).rejects.toThrow(`required local ports (${first.port}, ${second.port})`);
      expect(request).not.toHaveBeenCalled();
      const retry = await flows.start("owner", "scope", "openai", request, {});
      expect(retry.status).toBe("waiting");
    } finally {
      flows.dispose();
      await first.close();
      await second.close();
    }
  });

  it("allows an ephemeral port only when the native callback policy includes zero", async () => {
    const flows = createMeerkatAuthFlows();
    const request = vi.fn(async (_method: string, params: Record<string, unknown>) => {
      const redirect = new URL(String(params.redirectUri));
      expect(redirect.hostname).toBe("127.0.0.1");
      expect(Number(redirect.port)).toBeGreaterThan(0);
      expect(redirect.pathname).toBe("/callback");
      return { authorizeUrl: "https://auth.example/start", state: "native-state" };
    });
    try {
      expect(
        (
          await flows.start(
            "owner",
            "scope",
            "google",
            request,
            {},
            undefined,
            "account",
            async () => ({ redirectHost: "127.0.0.1", path: "/callback", ports: [0] }),
          )
        ).status,
      ).toBe("waiting");
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      flows.dispose();
    }
  });

  it.each([
    { redirectHost: "other.test", path: "/callback", ports: [0] },
    { redirectHost: "localhost", path: "/callback", ports: [] },
    { redirectHost: "localhost", path: "/callback", ports: [-1] },
    { redirectHost: "localhost", path: "/callback", ports: [65_536] },
    { redirectHost: "localhost", path: "/callback", ports: [1.5] },
    { redirectHost: "localhost", path: "//other.test/callback", ports: [0] },
    { redirectHost: "localhost", path: "/callback?override=true", ports: [0] },
    { redirectHost: "localhost", path: "/callback#fragment", ports: [0] },
    { redirectHost: "localhost", path: "/auth/../callback", ports: [0] },
    { redirectHost: "localhost", path: "/auth\\callback", ports: [0] },
  ])("rejects an invalid native callback policy: %j", async (policy) => {
    const flows = createMeerkatAuthFlows();
    const request = vi.fn();
    try {
      await expect(
        flows.start(
          "owner",
          "scope",
          "openai",
          request,
          {},
          undefined,
          "account",
          async () => policy as NonNullable<MeerkatAuthMethod["callback"]>,
        ),
      ).rejects.toThrow("invalid sign-in callback policy");
      expect(request).not.toHaveBeenCalled();
    } finally {
      flows.dispose();
    }
  });

  it("rejects unrelated callbacks", () => {
    const redirect = "http://127.0.0.1:43210/oauth/callback";
    expect(
      parseMeerkatAuthCallback(`${redirect}?state=expected&code=good`, redirect, "expected"),
    ).toBe("good");
    for (const value of [
      `${redirect}?state=other&code=bad`,
      "https://other.test/oauth/callback?state=expected&code=bad",
      `${redirect}?state=expected`,
      `${redirect}?state=expected&error=denied`,
    ])
      expect(() => parseMeerkatAuthCallback(value, redirect, "expected")).toThrow();
  });
  it("binds completion to its authenticated owner and retries an invalid callback safely", async () => {
    const flows = createMeerkatAuthFlows();
    let redirect = "";
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "auth.v1.loginStart") {
        redirect = String(params.redirectUri);
        return { authorizeUrl: "https://auth.example/start", state: "native-state" };
      }
      return { connected: true };
    });
    try {
      const flow = await flows.start("owner-a", "scope", "openai", request, {
        projectPath: "/fixture",
      });
      expect(() => flows.status(flow.flowId!, "owner-b", "scope", "openai")).toThrow();
      expect(() => flows.cancel(flow.flowId!, "owner-a", "other-scope", "openai")).toThrow();
      await expect(
        flows.complete(
          flow.flowId!,
          "owner-a",
          "scope",
          "openai",
          `${redirect}?state=wrong&code=bad`,
        ),
      ).rejects.toThrow();
      expect(flows.status(flow.flowId!, "owner-a", "scope", "openai").status).toBe("waiting");
      const result = await flows.complete(
        flow.flowId!,
        "owner-a",
        "scope",
        "openai",
        `${redirect}?state=native-state&code=good`,
      );
      expect(result.status).toBe("connected");
      expect(request).toHaveBeenLastCalledWith(
        "auth.v1.loginComplete",
        expect.objectContaining({
          provider: "openai",
          state: "native-state",
          code: "good",
          projectPath: "/fixture",
          redirectUri: redirect,
        }),
      );
      await flows.complete(
        flow.flowId!,
        "owner-a",
        "scope",
        "openai",
        `${redirect}?state=native-state&code=good`,
      );
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      flows.dispose();
    }
  });
  it("withdraws pending callbacks when signing out and fences a completion already in progress", async () => {
    const flows = createMeerkatAuthFlows();
    let redirect = "";
    let finish: (() => void) | undefined;
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "auth.v1.loginStart") {
        redirect = String(params.redirectUri);
        return { authorizeUrl: "https://auth.example/start", state: "native-state" };
      }
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return {};
    });
    try {
      const first = await flows.start("owner", "scope", "openai", request, {});
      flows.cancelProvider("scope", "openai");
      expect(() => flows.status(first.flowId!, "owner", "scope", "openai")).toThrow();
      const second = await flows.start("owner", "scope", "openai", request, {});
      const completion = flows.complete(
        second.flowId!,
        "owner",
        "scope",
        "openai",
        `${redirect}?state=native-state&code=good`,
      );
      expect(() => flows.cancelProvider("scope", "openai")).toThrow("completing");
      await expect(flows.start("owner", "scope", "openai", request, {})).rejects.toThrow(
        "completing",
      );
      finish!();
      await completion;
      flows.cancelProvider("scope", "openai");
      expect(() => flows.status(second.flowId!, "owner", "scope", "openai")).toThrow();
    } finally {
      finish?.();
      flows.dispose();
    }
  });

  it("signs out sibling targets of one account without cancelling a different account", async () => {
    const flows = createMeerkatAuthFlows();
    const request = vi.fn(async () => ({
      authorizeUrl: "https://auth.example/start",
      state: "native-state",
    }));
    try {
      const first = await flows.start(
        "owner-a",
        "thread-a",
        "openai",
        request,
        {},
        undefined,
        "shared-account",
      );
      const second = await flows.start(
        "owner-b",
        "thread-b",
        "openai",
        request,
        {},
        undefined,
        "shared-account",
      );
      const other = await flows.start(
        "owner-a",
        "thread-c",
        "openai",
        request,
        {},
        undefined,
        "other-account",
      );
      expect(() => flows.status(first.flowId!, "owner-a", "thread-b", "openai")).toThrow();
      flows.cancelProvider("shared-account", "openai");
      expect(() => flows.status(first.flowId!, "owner-a", "thread-a", "openai")).toThrow();
      expect(() => flows.status(second.flowId!, "owner-b", "thread-b", "openai")).toThrow();
      expect(flows.status(other.flowId!, "owner-a", "thread-c", "openai").status).toBe("waiting");
      expect(request).toHaveBeenCalledTimes(3);
    } finally {
      flows.dispose();
    }
  });

  it("cancels a reserved sign-in during account preflight without starting native login", async () => {
    const flows = createMeerkatAuthFlows();
    const preflight = deferred<void>();
    const request = vi.fn(async () => ({
      authorizeUrl: "https://auth.example/start",
      state: "state",
    }));
    const start = flows.start(
      "owner",
      "thread",
      "openai",
      request,
      {},
      undefined,
      "account",
      () => preflight.promise,
    );
    const rejected = expect(start).rejects.toThrow("cancelled");
    try {
      flows.cancelProvider("account", "openai");
      preflight.resolve(undefined);
      await rejected;
      expect(request).not.toHaveBeenCalled();
    } finally {
      preflight.resolve(undefined);
      flows.dispose();
    }
  });

  for (const action of ["cancel", "dispose"] as const) {
    it(`does not publish a late native loginStart result after ${action}`, async () => {
      const flows = createMeerkatAuthFlows();
      const entered = deferred<void>();
      const nativeResult = deferred<{ authorizeUrl: string; state: string }>();
      const request = vi.fn(async (method: string) => {
        expect(method).toBe("auth.v1.loginStart");
        entered.resolve(undefined);
        return nativeResult.promise;
      });
      const onConnected = vi.fn(async () => {});
      const start = flows.start("owner", "thread", "openai", request, {}, onConnected, "account");
      const rejected = expect(start).rejects.toThrow("cancelled");
      try {
        await entered.promise;
        if (action === "cancel") flows.cancelProvider("account", "openai");
        else flows.dispose();
        nativeResult.resolve({ authorizeUrl: "https://auth.example/obsolete", state: "obsolete" });
        await rejected;
        expect(request).toHaveBeenCalledTimes(1);
        expect(onConnected).not.toHaveBeenCalled();
      } finally {
        nativeResult.resolve({ authorizeUrl: "https://auth.example/obsolete", state: "obsolete" });
        flows.dispose();
      }
    });
  }

  it("keeps a replacement sign-in when the cancelled native start returns later", async () => {
    const flows = createMeerkatAuthFlows();
    const entered = deferred<void>();
    const obsolete = deferred<{ authorizeUrl: string; state: string }>();
    const oldRequest = vi.fn(async () => {
      entered.resolve(undefined);
      return obsolete.promise;
    });
    const newRequest = vi.fn(async () => ({
      authorizeUrl: "https://auth.example/current",
      state: "current",
    }));
    const oldStart = flows.start("owner", "scope", "openai", oldRequest, {});
    const rejected = expect(oldStart).rejects.toThrow("cancelled");
    try {
      await entered.promise;
      const current = await flows.start("owner", "scope", "openai", newRequest, {});
      obsolete.resolve({ authorizeUrl: "https://auth.example/obsolete", state: "obsolete" });
      await rejected;
      expect(flows.status(current.flowId!, "owner", "scope", "openai")).toEqual(current);
      expect(oldRequest).toHaveBeenCalledTimes(1);
      expect(newRequest).toHaveBeenCalledTimes(1);
    } finally {
      obsolete.resolve({ authorizeUrl: "https://auth.example/obsolete", state: "obsolete" });
      flows.dispose();
    }
  });

  it("reserves capacity before preflight and frees cancelled pending starts", async () => {
    const flows = createMeerkatAuthFlows();
    const preflight = deferred<void>();
    const request = vi.fn(async () => ({
      authorizeUrl: "https://auth.example/start",
      state: "state",
    }));
    const starts = Array.from({ length: 128 }, (_, i) =>
      flows.start(
        `owner-${i}`,
        "scope",
        "openai",
        request,
        {},
        undefined,
        "account",
        () => preflight.promise,
      ),
    );
    const settled = Promise.allSettled(starts);
    try {
      await expect(flows.start("extra", "scope", "openai", request, {})).rejects.toThrow(
        "Too many",
      );
      flows.cancelProvider("account", "openai");
      const fresh = await flows.start("extra", "scope", "openai", request, {});
      expect(fresh.status).toBe("waiting");
      preflight.resolve(undefined);
      expect((await settled).every((result) => result.status === "rejected")).toBe(true);
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      preflight.resolve(undefined);
      flows.dispose();
    }
  });

  it("fences sibling starts and duplicate logout until logout settles, without blocking other accounts", async () => {
    const flows = createMeerkatAuthFlows();
    const logoutResult = deferred<void>();
    const operation = vi.fn(() => logoutResult.promise);
    const request = vi.fn(async () => ({
      authorizeUrl: "https://auth.example/start",
      state: "state",
    }));
    const logout = flows.runLogout("account", "openai", operation);
    const rejected = expect(logout).rejects.toThrow("Native logout failed");
    try {
      await expect(
        flows.start("other-owner", "sibling-thread", "openai", request, {}, undefined, "account"),
      ).rejects.toThrow("Sign-out is in progress");
      await expect(flows.runLogout("account", "openai", operation)).rejects.toThrow(
        "already in progress",
      );
      const other = await flows.start(
        "owner",
        "other-thread",
        "openai",
        request,
        {},
        undefined,
        "other-account",
      );
      expect(other.status).toBe("waiting");
      logoutResult.reject(new Error("Native logout failed"));
      await rejected;
      const next = await flows.start(
        "owner",
        "thread",
        "openai",
        request,
        {},
        undefined,
        "account",
      );
      expect(next.status).toBe("waiting");
      expect(operation).toHaveBeenCalledTimes(1);
    } finally {
      logoutResult.resolve(undefined);
      flows.dispose();
    }
  });

  it("keeps successful native sign-in when readiness publication fails", async () => {
    const flows = createMeerkatAuthFlows();
    let redirect = "";
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "auth.v1.loginStart") {
        redirect = String(params.redirectUri);
        return { authorizeUrl: "https://auth.example/start", state: "native-state" };
      }
      return {};
    });
    const onConnected = vi.fn(async () => {
      throw new Error("Projection unavailable");
    });
    try {
      const flow = await flows.start("owner", "scope", "openai", request, {}, onConnected);
      const callback = `${redirect}?state=native-state&code=good`;
      const result = await flows.complete(flow.flowId!, "owner", "scope", "openai", callback);
      expect(result.status).toBe("connected");
      expect(result.message).toContain("Refresh provider status in Settings");
      expect(onConnected).toHaveBeenCalledTimes(1);
      expect(await flows.complete(flow.flowId!, "owner", "scope", "openai", callback)).toEqual(
        result,
      );
      expect(
        request.mock.calls.filter(([method]) => method === "auth.v1.loginComplete"),
      ).toHaveLength(1);
      expect(onConnected).toHaveBeenCalledTimes(1);
    } finally {
      flows.dispose();
    }
  });

  it("does not publish readiness after rejected native sign-in", async () => {
    const flows = createMeerkatAuthFlows();
    let redirect = "";
    const request = async (method: string, params: Record<string, unknown>) => {
      if (method === "auth.v1.loginStart") {
        redirect = String(params.redirectUri);
        return { authorizeUrl: "https://auth.example/start", state: "native-state" };
      }
      throw new Error("Native sign-in failed");
    };
    const onConnected = vi.fn(async () => {});
    try {
      const flow = await flows.start("owner", "scope", "openai", request, {}, onConnected);
      const result = await flows.complete(
        flow.flowId!,
        "owner",
        "scope",
        "openai",
        `${redirect}?state=native-state&code=good`,
      );
      expect(result.status).toBe("failed");
      expect(onConnected).not.toHaveBeenCalled();
    } finally {
      flows.dispose();
    }
  });

  it("keeps an expired browser result readable and dismissible after releasing its callback", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(0);
    const flows = createMeerkatAuthFlows();
    let redirect = "";
    const request = vi.fn(async (_method: string, params: Record<string, unknown>) => {
      redirect = String(params.redirectUri);
      return { authorizeUrl: "https://auth.example/start", state: "native-state" };
    });
    try {
      const flow = await flows.start("owner", "scope", "openai", request, {});
      expect(flow.expiresAt).toBe("1970-01-01T00:05:00.000Z");
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      const expired = flows.status(flow.flowId!, "owner", "scope", "openai");
      expect(expired).toMatchObject({
        flowId: flow.flowId,
        authorizeUrl: null,
        status: "failed",
        message: "Sign-in expired. Start again.",
        expiresAt: flow.expiresAt,
      });
      await expect(callbackStatus(redirect)).rejects.toThrow("ECONNREFUSED");
      for (const [owner, scope, provider] of [
        ["other-owner", "scope", "openai"],
        ["owner", "other-scope", "openai"],
        ["owner", "scope", "anthropic"],
      ] as const) {
        expect(() => flows.status(flow.flowId!, owner, scope, provider)).toThrow("unavailable");
        expect(() => flows.cancel(flow.flowId!, owner, scope, provider)).toThrow("unavailable");
      }
      expect(request).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);
      const cancelled = flows.cancel(flow.flowId!, "owner", "scope", "openai");
      expect(cancelled).toEqual({
        flowId: null,
        authorizeUrl: null,
        status: "cancelled",
        message: null,
      });
      expect(flows.cancel(flow.flowId!, "owner", "scope", "openai")).toEqual(cancelled);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      flows.dispose();
      vi.useRealTimers();
    }
  });

  it("bounds expired result retention without preventing dismissal after a long absence", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const flows = createMeerkatAuthFlows();
    const request = vi.fn(async () => ({
      authorizeUrl: "https://auth.example/start",
      state: "native-state",
    }));
    try {
      const flow = await flows.start("owner", "scope", "openai", request, {});
      await vi.advanceTimersByTimeAsync(10 * 60_000 - 1);
      expect(flows.status(flow.flowId!, "owner", "scope", "openai").status).toBe("failed");
      await vi.advanceTimersByTimeAsync(1);
      expect(() => flows.status(flow.flowId!, "owner", "scope", "openai")).toThrow("unavailable");
      expect(vi.getTimerCount()).toBe(0);
      expect(flows.cancel(flow.flowId!, "owner", "scope", "openai").status).toBe("cancelled");
      expect(flows.cancel(flow.flowId!, "owner", "scope", "openai").status).toBe("cancelled");
      expect(request).toHaveBeenCalledTimes(1);
      const retry = await flows.start("owner", "scope", "openai", request, {});
      expect(retry.status).toBe("waiting");
      expect(vi.getTimerCount()).toBe(1);
      flows.dispose();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      flows.dispose();
      vi.useRealTimers();
    }
  });

  it("retains a completed result for a bounded period and clears its callback deadline", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const flows = createMeerkatAuthFlows();
    let redirect = "";
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "auth.v1.loginStart") {
        redirect = String(params.redirectUri);
        return { authorizeUrl: "https://auth.example/start", state: "native-state" };
      }
      return {};
    });
    try {
      const flow = await flows.start("owner", "scope", "openai", request, {});
      await vi.advanceTimersByTimeAsync(60_000);
      const result = await flows.complete(
        flow.flowId!,
        "owner",
        "scope",
        "openai",
        `${redirect}?state=native-state&code=good`,
      );
      expect(result.status).toBe("connected");
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
      expect(flows.status(flow.flowId!, "owner", "scope", "openai")).toEqual(result);
      await vi.advanceTimersByTimeAsync(1);
      expect(() => flows.status(flow.flowId!, "owner", "scope", "openai")).toThrow("unavailable");
      expect(vi.getTimerCount()).toBe(0);
      expect(flows.cancel(flow.flowId!, "owner", "scope", "openai").status).toBe("cancelled");
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      flows.dispose();
      vi.useRealTimers();
    }
  });

  it("preserves native completion when the flow expires during readiness publication", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const flows = createMeerkatAuthFlows();
    let redirect = "";
    let finishPublication!: () => void;
    let notifyPublication!: () => void;
    const publicationStarted = new Promise<void>((resolve) => {
      notifyPublication = resolve;
    });
    const publicationFinished = new Promise<void>((resolve) => {
      finishPublication = resolve;
    });
    const request = async (method: string, params: Record<string, unknown>) => {
      if (method === "auth.v1.loginStart") {
        redirect = String(params.redirectUri);
        return { authorizeUrl: "https://auth.example/start", state: "native-state" };
      }
      return {};
    };
    try {
      const flow = await flows.start("owner", "scope", "openai", request, {}, async () => {
        notifyPublication();
        await publicationFinished;
      });
      const completion = flows.complete(
        flow.flowId!,
        "owner",
        "scope",
        "openai",
        `${redirect}?state=native-state&code=good`,
      );
      await publicationStarted;
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(flows.status(flow.flowId!, "owner", "scope", "openai").status).toBe("connected");
      finishPublication();
      expect((await completion).status).toBe("connected");
    } finally {
      finishPublication();
      flows.dispose();
      vi.useRealTimers();
    }
  });

  it("keeps logout fenced when a sign-in expires during native completion", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const flows = createMeerkatAuthFlows();
    const entered = deferred<void>();
    const nativeCompletion = deferred<void>();
    let redirect = "";
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "auth.v1.loginStart") {
        redirect = String(params.redirectUri);
        return { authorizeUrl: "https://auth.example/start", state: "native-state" };
      }
      expect(method).toBe("auth.v1.loginComplete");
      entered.resolve(undefined);
      await nativeCompletion.promise;
      return {};
    });
    const logout = vi.fn(async () => ({}));
    try {
      const flow = await flows.start(
        "owner",
        "thread",
        "openai",
        request,
        {},
        undefined,
        "account",
      );
      const completion = flows.complete(
        flow.flowId!,
        "owner",
        "thread",
        "openai",
        `${redirect}?state=native-state&code=good`,
      );
      await entered.promise;
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(flows.status(flow.flowId!, "owner", "thread", "openai")).toMatchObject({
        status: "waiting",
        authorizeUrl: null,
        expiresAt: flow.expiresAt,
      });
      expect(() => flows.cancel(flow.flowId!, "owner", "thread", "openai")).toThrow("completing");
      await expect(flows.runLogout("account", "openai", logout)).rejects.toThrow("completing");
      await expect(
        flows.start("owner", "thread", "openai", request, {}, undefined, "account"),
      ).rejects.toThrow("completing");
      expect(logout).not.toHaveBeenCalled();
      nativeCompletion.resolve(undefined);
      expect((await completion).status).toBe("connected");
      await flows.runLogout("account", "openai", logout);
      expect(logout).toHaveBeenCalledTimes(1);
      expect(() => flows.status(flow.flowId!, "owner", "thread", "openai")).toThrow("unavailable");
    } finally {
      nativeCompletion.resolve(undefined);
      flows.dispose();
      vi.useRealTimers();
    }
  });
});

describe("Native device-code sign-in", () => {
  it("never forwards private device credentials through native errors or malformed responses", async () => {
    vi.useFakeTimers();
    const flows = createMeerkatAuthFlows();
    const device = {
      deviceCode: "fixture-private-device",
      userCode: "ABCD",
      verificationUri: "https://github.com/login/device",
      verificationUriComplete: null,
      expiresIn: 60,
      interval: 5,
    };
    try {
      await expect(
        flows.startDevice(
          "owner",
          "malformed",
          "openai",
          async () => ({ ...device, expiresIn: "fixture-private-device" }),
          {},
        ),
      ).rejects.toThrow("invalid device sign-in response");
      const view = await flows.startDevice(
        "owner",
        "scope",
        "openai",
        async (method) => {
          if (method === "auth.v1.deviceStart") return device;
          throw new Error("native rejected fixture-private-device");
        },
        {},
      );
      vi.advanceTimersByTime(5000);
      await expect(flows.pollDevice(view.flowId!, "owner", "scope", "openai")).rejects.toThrow(
        "Could not check device sign-in. Try again.",
      );
      expect(JSON.stringify(flows.status(view.flowId!, "owner", "scope", "openai"))).not.toContain(
        "fixture-private-device",
      );
      const failed = await flows.startDevice(
        "owner",
        "failure",
        "openai",
        async (method) =>
          method === "auth.v1.deviceStart"
            ? device
            : { status: "failed", message: "diagnostic fixture-private-device" },
        {},
      );
      vi.advanceTimersByTime(5000);
      expect(
        JSON.stringify(await flows.pollDevice(failed.flowId!, "owner", "failure", "openai")),
      ).not.toContain("fixture-private-device");
    } finally {
      flows.dispose();
      vi.useRealTimers();
    }
  });

  it("keeps device credentials on the server, respects polling intervals and rejects another owner", async () => {
    vi.useFakeTimers();
    const flows = createMeerkatAuthFlows();
    const connected = vi.fn(async () => {});
    const request = vi.fn(async (method: string) =>
      method === "auth.v1.deviceStart"
        ? {
            deviceCode: "private-device-credential",
            userCode: "ABCD-EFGH",
            verificationUri: "https://github.com/login/device",
            verificationUriComplete: null,
            expiresIn: 600,
            interval: 5,
          }
        : { status: "connected" },
    );
    try {
      const view = await flows.startDevice(
        "owner",
        "scope",
        "openai",
        request,
        { bindingId: "work" },
        connected,
      );
      expect(JSON.stringify(view)).not.toContain("private-device-credential");
      expect(view.userCode).toBe("ABCD-EFGH");
      await expect(flows.pollDevice(view.flowId!, "other", "scope", "openai")).rejects.toThrow(
        "unavailable",
      );
      expect((await flows.pollDevice(view.flowId!, "owner", "scope", "openai")).status).toBe(
        "waiting",
      );
      expect(request).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(5000);
      expect((await flows.pollDevice(view.flowId!, "owner", "scope", "openai")).status).toBe(
        "connected",
      );
      expect(request).toHaveBeenLastCalledWith("auth.v1.devicePoll", {
        bindingId: "work",
        provider: "openai",
        deviceCode: "private-device-credential",
      });
      expect(connected).toHaveBeenCalledTimes(1);
      await flows.pollDevice(view.flowId!, "owner", "scope", "openai");
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      flows.dispose();
      vi.useRealTimers();
    }
  });

  it.each(["updated", "unchanged", "needs_selection"] as const)(
    "retains %s device activation without retrying committed sign-in after a refresh failure",
    async (status) => {
      vi.useFakeTimers();
      const flows = createMeerkatAuthFlows();
      const defaultActivation = {
        status,
        providers: status === "updated" ? ["openai", "anthropic", "gemini"] : [],
      };
      const request = vi.fn(async (method: string) =>
        method === "auth.v1.deviceStart"
          ? {
              deviceCode: "private-device-credential",
              userCode: "ABCD-EFGH",
              verificationUri: "https://github.com/login/device",
              verificationUriComplete: null,
              expiresIn: 600,
              interval: 5,
            }
          : { status: "connected", defaultActivation, token: "private-native-token" },
      );
      const refresh = vi.fn(async () => {
        throw new Error("Catalog unavailable");
      });
      try {
        const flow = await flows.startDevice("owner", "scope", "openai", request, {}, refresh);
        vi.advanceTimersByTime(5000);
        const result = await flows.pollDevice(flow.flowId!, "owner", "scope", "openai");
        expect(result.status).toBe("connected");
        expect(result.defaultActivation).toEqual(defaultActivation);
        expect(JSON.stringify(result)).not.toContain("private-");
        expect(await flows.pollDevice(flow.flowId!, "owner", "scope", "openai")).toEqual(result);
        expect(request.mock.calls.map(([method]) => method)).toEqual([
          "auth.v1.deviceStart",
          "auth.v1.devicePoll",
        ]);
        expect(refresh).toHaveBeenCalledTimes(1);
      } finally {
        flows.dispose();
        vi.useRealTimers();
      }
    },
  );

  it("expires without contacting the provider and keeps a pending poll fenced from logout", async () => {
    vi.useFakeTimers();
    const flows = createMeerkatAuthFlows();
    const poll = deferred<{ status: "connected" }>();
    const request = vi.fn(async (method: string) =>
      method === "auth.v1.deviceStart"
        ? {
            deviceCode: "fixture-device",
            userCode: "ABCD",
            verificationUri: "https://github.com/login/device",
            verificationUriComplete: null,
            expiresIn: 60,
            interval: 5,
          }
        : poll.promise,
    );
    try {
      const expired = await flows.startDevice("owner", "expired", "openai", request, {});
      vi.advanceTimersByTime(61000);
      expect((await flows.pollDevice(expired.flowId!, "owner", "expired", "openai")).status).toBe(
        "failed",
      );
      expect(request).toHaveBeenCalledTimes(1);
      const view = await flows.startDevice("owner", "scope", "openai", request, {});
      vi.advanceTimersByTime(5000);
      const running = flows.pollDevice(view.flowId!, "owner", "scope", "openai");
      await expect(flows.runLogout("scope", "openai", async () => {})).rejects.toThrow(
        "completing",
      );
      poll.resolve({ status: "connected" });
      expect((await running).status).toBe("connected");
      await flows.runLogout("scope", "openai", async () => {});
      expect(() => flows.status(view.flowId!, "owner", "scope", "openai")).toThrow("unavailable");
    } finally {
      poll.resolve({ status: "connected" });
      flows.dispose();
      vi.useRealTimers();
    }
  });
});
