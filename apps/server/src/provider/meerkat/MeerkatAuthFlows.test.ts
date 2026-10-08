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

describe("Meerkat provider sign-in", () => {
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
      expect(() => flows.status(flow.flowId!, "owner", "scope", "openai")).toThrow("unavailable");
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
      expect(() => flows.status(flow.flowId!, "owner", "thread", "openai")).toThrow("unavailable");
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
