// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Node owns the OAuth loopback and its bounded lifetime.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import { MeerkatAuthFlow } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const LoginStart = Schema.Struct({ authorizeUrl: Schema.String, state: Schema.String });
const decodeLoginStart = Schema.decodeUnknownSync(LoginStart);
type Request = (method: string, params: Record<string, unknown>) => Promise<unknown>;
interface Flow {
  owner: string;
  scope: string;
  cancellationScope: string;
  provider: string;
  state: string;
  redirectUri: string;
  request: Request;
  params: Record<string, unknown>;
  onConnected?: () => Promise<void>;
  view: MeerkatAuthFlow;
  server: NodeHttp.Server;
  timer: ReturnType<typeof setTimeout>;
  completing: boolean;
  expired: boolean;
}
interface PendingStart {
  owner: string;
  scope: string;
  cancellationScope: string;
  provider: string;
  cancel: () => void;
}

export function parseMeerkatAuthCallback(
  value: string,
  redirectUri: string,
  state: string,
): string {
  const callback = new URL(value);
  const redirect = new URL(redirectUri);
  if (
    callback.origin !== redirect.origin ||
    callback.pathname !== redirect.pathname ||
    callback.searchParams.get("state") !== state
  )
    throw new Error("This callback does not belong to this sign-in attempt.");
  const error = callback.searchParams.get("error");
  if (error) throw new Error("The provider declined this sign-in attempt.");
  const code = callback.searchParams.get("code");
  if (!code) throw new Error("The callback is missing its authorization code.");
  return code;
}

/** Flows remain bound to their authenticated client and native provider instance. */
export function createMeerkatAuthFlows() {
  const flows = new Map<string, Flow>();
  const pendingStarts = new Map<string, PendingStart>();
  const logouts = new Map<string, object>();
  let disposed = false;
  const accountKey = (scope: string, provider: string) => JSON.stringify([scope, provider]);
  const cancelledStart = () =>
    new Error("This sign-in attempt was cancelled. Start a new sign-in.");
  const close = (flow: Flow) => {
    flow.server.close();
  };
  const get = (id: string | undefined, owner: string, scope: string, provider: string) => {
    const flow = id ? flows.get(id) : undefined;
    if (
      !flow ||
      flow.expired ||
      flow.owner !== owner ||
      flow.scope !== scope ||
      flow.provider !== provider
    )
      throw new Error("This sign-in attempt is unavailable. Start a new sign-in.");
    return flow;
  };
  const complete = async (flow: Flow, callback: string) => {
    if (flow.expired || flows.get(flow.view.flowId ?? "") !== flow)
      throw new Error("This sign-in attempt is unavailable. Start a new sign-in.");
    if (flow.view.status !== "waiting" || flow.completing) return flow.view;
    // An unrelated callback must not consume the real pending sign-in.
    const code = parseMeerkatAuthCallback(callback, flow.redirectUri, flow.state);
    flow.completing = true;
    try {
      await flow.request("auth.v1.loginComplete", {
        ...flow.params,
        provider: flow.provider,
        redirectUri: flow.redirectUri,
        state: flow.state,
        code,
      });
      flow.view = { ...flow.view, authorizeUrl: null, status: "connected", message: "Signed in." };
      // Browser callbacks can outlive the client that started sign-in.
      // Projection failure must not turn durably saved credentials into an auth failure.
      try {
        await flow.onConnected?.();
      } catch {
        flow.view = {
          ...flow.view,
          message: "Signed in. Refresh provider status in Settings to update model availability.",
        };
      }
    } catch {
      flow.view = {
        ...flow.view,
        authorizeUrl: null,
        status: "failed",
        message: "Sign-in could not be completed. Start a new sign-in.",
      };
    } finally {
      flow.completing = false;
      close(flow);
      if (flow.expired) flows.delete(flow.view.flowId!);
    }
    return flow.view;
  };
  const cancelProvider = (scope: string, provider: string) => {
    const pending = [...flows.entries()].filter(
      ([, flow]) => flow.cancellationScope === scope && flow.provider === provider,
    );
    if (pending.some(([, flow]) => flow.completing))
      throw new Error("Sign-in is completing. Refresh its status before signing out.");
    for (const [id, start] of pendingStarts) {
      if (start.cancellationScope === scope && start.provider === provider) {
        start.cancel();
        pendingStarts.delete(id);
      }
    }
    for (const [id, flow] of pending) {
      clearTimeout(flow.timer);
      close(flow);
      flows.delete(id);
    }
  };
  return {
    async start(
      owner: string,
      scope: string,
      provider: string,
      request: Request,
      params: Record<string, unknown>,
      onConnected?: () => Promise<void>,
      cancellationScope = scope,
      prepare?: () => Promise<void>,
    ): Promise<MeerkatAuthFlow> {
      if (disposed) throw new Error("Provider sign-in is unavailable.");
      if (logouts.has(accountKey(cancellationScope, provider)))
        throw new Error("Sign-out is in progress. Wait before starting a new sign-in.");
      const previous = [...flows.entries()].filter(
        ([, flow]) => flow.owner === owner && flow.scope === scope && flow.provider === provider,
      );
      if (previous.some(([, flow]) => flow.completing))
        throw new Error("Sign-in is completing. Refresh its status.");
      for (const [id, start] of pendingStarts) {
        if (start.owner === owner && start.scope === scope && start.provider === provider) {
          start.cancel();
          pendingStarts.delete(id);
        }
      }
      for (const [id, flow] of previous) {
        clearTimeout(flow.timer);
        close(flow);
        flows.delete(id);
      }
      if (flows.size + pendingStarts.size >= 128)
        throw new Error("Too many sign-in attempts. Try again later.");
      const id = NodeCrypto.randomUUID();
      let cancelled = false;
      let flow: Flow | undefined;
      let server: NodeHttp.Server | undefined;
      let cancelListen: (() => void) | undefined;
      const pending: PendingStart = {
        owner,
        scope,
        cancellationScope,
        provider,
        cancel: () => {
          cancelled = true;
          cancelListen?.();
          server?.close();
        },
      };
      const assertCurrent = () => {
        if (cancelled || disposed || pendingStarts.get(id) !== pending) throw cancelledStart();
      };
      // Logout must see the attempt before account preflight or loopback/native startup yields.
      pendingStarts.set(id, pending);
      try {
        await prepare?.();
        assertCurrent();
        const listener = NodeHttp.createServer(async (req, res) => {
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.setHeader("Cache-Control", "no-store");
          if (!flow || req.method !== "GET") {
            res.writeHead(400);
            res.end("Invalid callback.");
            return;
          }
          try {
            const view = await complete(flow, new URL(req.url ?? "/", flow.redirectUri).href);
            res.writeHead(view.status === "connected" ? 200 : 400);
            res.end(
              view.status === "connected"
                ? "Signed in. You may close this tab and return to Meerkat."
                : "Sign-in was not completed. Return to Meerkat.",
            );
          } catch {
            res.writeHead(400);
            res.end("This callback does not match the pending sign-in.");
          }
        });
        server = listener;
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            listener.off("error", onError);
            listener.off("listening", onListening);
            cancelListen = undefined;
          };
          const onError = (error: Error) => {
            cleanup();
            reject(error);
          };
          const onListening = () => {
            cleanup();
            resolve();
          };
          cancelListen = () => {
            cleanup();
            reject(cancelledStart());
          };
          listener.once("error", onError);
          listener.once("listening", onListening);
          listener.listen(0, "127.0.0.1");
        });
        assertCurrent();
        const address = listener.address();
        if (!address || typeof address === "string")
          throw new Error("Could not open the sign-in callback.");
        const redirectUri = `http://127.0.0.1:${address.port}/oauth/callback`;
        const loginResult = await request("auth.v1.loginStart", {
          ...params,
          provider,
          redirectUri,
        });
        // A cancelled native start is only discarded locally. Never log out a newer sign-in.
        assertCurrent();
        const login = decodeLoginStart(loginResult);
        const timer = setTimeout(() => {
          if (flow) {
            flow.expired = true;
            close(flow);
            // Hide expired flows, but preserve the account's completion guard
            // until the native request and its readiness publication settle.
            if (flow.completing) return;
            if (flow.view.status === "waiting")
              flow.view = {
                ...flow.view,
                authorizeUrl: null,
                status: "failed",
                message: "Sign-in expired. Start again.",
              };
            flows.delete(id);
          }
        }, 5 * 60_000);
        timer.unref();
        listener.unref();
        flow = {
          owner,
          scope,
          cancellationScope,
          provider,
          request,
          params,
          ...(onConnected ? { onConnected } : {}),
          state: login.state,
          redirectUri,
          timer,
          server: listener,
          completing: false,
          expired: false,
          view: { flowId: id, authorizeUrl: login.authorizeUrl, status: "waiting", message: null },
        };
        pendingStarts.delete(id);
        flows.set(id, flow);
        return flow.view;
      } catch (error) {
        server?.close();
        throw error;
      } finally {
        if (pendingStarts.get(id) === pending) pendingStarts.delete(id);
      }
    },
    status(id: string | undefined, owner: string, scope: string, provider: string) {
      return get(id, owner, scope, provider).view;
    },
    complete(
      id: string | undefined,
      owner: string,
      scope: string,
      provider: string,
      callback: string,
    ) {
      return complete(get(id, owner, scope, provider), callback);
    },
    cancel(id: string | undefined, owner: string, scope: string, provider: string) {
      const flow = get(id, owner, scope, provider);
      if (flow.completing) throw new Error("Sign-in is completing. Refresh its status.");
      clearTimeout(flow.timer);
      close(flow);
      flows.delete(id!);
      return {
        flowId: null,
        authorizeUrl: null,
        status: "cancelled",
        message: null,
      } satisfies MeerkatAuthFlow;
    },
    cancelProvider,
    async runLogout<A>(scope: string, provider: string, operation: () => Promise<A>): Promise<A> {
      if (disposed) throw new Error("Provider sign-out is unavailable.");
      const key = accountKey(scope, provider);
      if (logouts.has(key)) throw new Error("Sign-out is already in progress. Refresh its status.");
      cancelProvider(scope, provider);
      const reservation = {};
      logouts.set(key, reservation);
      try {
        return await operation();
      } finally {
        if (logouts.get(key) === reservation) logouts.delete(key);
      }
    },
    dispose() {
      disposed = true;
      for (const start of pendingStarts.values()) start.cancel();
      pendingStarts.clear();
      for (const flow of flows.values()) {
        clearTimeout(flow.timer);
        close(flow);
      }
      flows.clear();
    },
  };
}
