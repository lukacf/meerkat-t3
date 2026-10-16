// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - Node owns the OAuth loopback and device-code deadlines.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import {
  MeerkatAuthFlow,
  MeerkatAuthDefaultActivation,
  type MeerkatAuthMethod,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const LoginStart = Schema.Struct({ authorizeUrl: Schema.String, state: Schema.String });
const decodeLoginStart = Schema.decodeUnknownSync(LoginStart);
const decodeLoginComplete = Schema.decodeUnknownSync(
  Schema.Struct({ defaultActivation: Schema.optional(MeerkatAuthDefaultActivation) }),
);
const decodeDeviceStart = Schema.decodeUnknownSync(
  Schema.Struct({
    deviceCode: Schema.String,
    userCode: Schema.String,
    verificationUri: Schema.String,
    verificationUriComplete: Schema.NullOr(Schema.String),
    expiresIn: Schema.Number,
    interval: Schema.Number,
  }),
);
const decodeDevicePoll = Schema.decodeUnknownSync(
  Schema.Struct({
    status: Schema.Literals(["waiting", "connected", "failed"]),
    retryAfterSeconds: Schema.optional(Schema.Number),
    message: Schema.optional(Schema.NullOr(Schema.String)),
    defaultActivation: Schema.optional(MeerkatAuthDefaultActivation),
  }),
);
const readDeviceStart = (value: unknown) => {
  try {
    return decodeDeviceStart(value);
  } catch {
    // Schema diagnostics can contain the private device credential from input.
    throw new Error("The provider returned an invalid device sign-in response.");
  }
};
type Request = (method: string, params: Record<string, unknown>) => Promise<unknown>;
const browserFlowLifetimeMs = 5 * 60_000;
const terminalFlowRetentionMs = 5 * 60_000;
type CallbackPolicy = NonNullable<MeerkatAuthMethod["callback"]>;
const defaultCallbackPolicy: CallbackPolicy = {
  redirectHost: "127.0.0.1",
  path: "/oauth/callback",
  ports: [0],
};
const readCallbackPolicy = (value: CallbackPolicy): CallbackPolicy => {
  if (
    !value ||
    (value.redirectHost !== "localhost" && value.redirectHost !== "127.0.0.1") ||
    typeof value.path !== "string" ||
    !value.path.startsWith("/") ||
    value.path.startsWith("//") ||
    !Array.isArray(value.ports) ||
    value.ports.length === 0 ||
    value.ports.length > 16 ||
    value.ports.some((port) => !Number.isInteger(port) || port < 0 || port > 65_535)
  )
    throw new Error("The provider returned an invalid sign-in callback policy.");
  const parsed = new URL(value.path, "http://127.0.0.1");
  if (
    parsed.origin !== "http://127.0.0.1" ||
    parsed.pathname !== value.path ||
    parsed.search ||
    parsed.hash
  )
    throw new Error("The provider returned an invalid sign-in callback policy.");
  return { ...value, ports: [...value.ports] };
};
interface DeviceFlow {
  owner: string;
  scope: string;
  cancellationScope: string;
  provider: string;
  request: Request;
  params: Record<string, unknown>;
  deviceCode: string;
  view: MeerkatAuthFlow;
  expiresAt: number;
  pollAfter: number;
  polling: boolean;
  onConnected?: () => Promise<void>;
}
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
  const deviceFlows = new Map<string, DeviceFlow>();
  const pendingStarts = new Map<string, PendingStart>();
  const logouts = new Map<string, object>();
  let disposed = false;
  const accountKey = (scope: string, provider: string) => JSON.stringify([scope, provider]);
  const cancelledStart = () =>
    new Error("This sign-in attempt was cancelled. Start a new sign-in.");
  const close = (flow: Flow) => {
    flow.server.close();
  };
  const retainTerminal = (flow: Flow) => {
    const id = flow.view.flowId;
    if (!id || flows.get(id) !== flow) return;
    clearTimeout(flow.timer);
    flow.timer = setTimeout(() => {
      if (flows.get(id) === flow) flows.delete(id);
    }, terminalFlowRetentionMs);
    flow.timer.unref();
  };
  const get = (id: string | undefined, owner: string, scope: string, provider: string) => {
    const flow = id ? flows.get(id) : undefined;
    if (!flow || flow.owner !== owner || flow.scope !== scope || flow.provider !== provider)
      throw new Error("This sign-in attempt is unavailable. Start a new sign-in.");
    return flow;
  };
  const complete = async (flow: Flow, callback: string) => {
    if (flows.get(flow.view.flowId ?? "") !== flow)
      throw new Error("This sign-in attempt is unavailable. Start a new sign-in.");
    if (flow.view.status !== "waiting" || flow.completing) return flow.view;
    if (flow.expired) throw new Error("This sign-in attempt is unavailable. Start a new sign-in.");
    // An unrelated callback must not consume the real pending sign-in.
    const code = parseMeerkatAuthCallback(callback, flow.redirectUri, flow.state);
    flow.completing = true;
    try {
      const result = decodeLoginComplete(
        await flow.request("auth.v1.loginComplete", {
          ...flow.params,
          provider: flow.provider,
          redirectUri: flow.redirectUri,
          state: flow.state,
          code,
        }),
      );
      flow.view = {
        ...flow.view,
        authorizeUrl: null,
        status: "connected",
        message:
          result.defaultActivation?.status === "needs_selection"
            ? "Signed in. Choose a default account in Providers to use its models."
            : "Signed in.",
        ...(result.defaultActivation ? { defaultActivation: result.defaultActivation } : {}),
      };
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
      retainTerminal(flow);
    }
    return flow.view;
  };
  const cancelProvider = (scope: string, provider: string) => {
    const devices = [...deviceFlows.entries()].filter(
      ([, flow]) => flow.cancellationScope === scope && flow.provider === provider,
    );
    if (devices.some(([, flow]) => flow.polling))
      throw new Error("Sign-in is completing. Refresh its status before signing out.");
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
    for (const [id] of devices) deviceFlows.delete(id);
  };
  const getDevice = (id: string | undefined, owner: string, scope: string, provider: string) => {
    const flow = id ? deviceFlows.get(id) : undefined;
    if (!flow || flow.owner !== owner || flow.scope !== scope || flow.provider !== provider)
      throw new Error("This sign-in attempt is unavailable. Start a new sign-in.");
    return flow;
  };
  return {
    async startDevice(
      owner: string,
      scope: string,
      provider: string,
      request: Request,
      params: Record<string, unknown>,
      onConnected?: () => Promise<void>,
      cancellationScope = scope,
      prepare?: () => Promise<CallbackPolicy | void>,
    ): Promise<MeerkatAuthFlow> {
      if (disposed) throw new Error("Provider sign-in is unavailable.");
      if (logouts.has(accountKey(cancellationScope, provider)))
        throw new Error("Sign-out is in progress. Wait before starting a new sign-in.");
      for (const [id, flow] of deviceFlows) {
        if (flow.expiresAt <= Date.now() && !flow.polling) deviceFlows.delete(id);
      }
      if (flows.size + deviceFlows.size + pendingStarts.size >= 128)
        throw new Error("Too many sign-in attempts. Try again later.");
      for (const [id, existing] of flows) {
        if (
          existing.owner === owner &&
          existing.scope === scope &&
          existing.provider === provider
        ) {
          if (existing.completing) throw new Error("Sign-in is completing. Refresh its status.");
          clearTimeout(existing.timer);
          close(existing);
          flows.delete(id);
        }
      }
      for (const [id, existing] of pendingStarts) {
        if (
          existing.owner === owner &&
          existing.scope === scope &&
          existing.provider === provider
        ) {
          existing.cancel();
          pendingStarts.delete(id);
        }
      }
      // A native device poll can commit credentials. Keep its guard until it settles.
      for (const [id, existing] of deviceFlows) {
        if (
          existing.owner === owner &&
          existing.scope === scope &&
          existing.provider === provider
        ) {
          if (existing.polling) throw new Error("Sign-in is completing. Refresh its status.");
          deviceFlows.delete(id);
        }
      }
      const id = NodeCrypto.randomUUID();
      let cancelled = false;
      const pending = {
        owner,
        scope,
        cancellationScope,
        provider,
        cancel: () => {
          cancelled = true;
        },
      };
      pendingStarts.set(id, pending);
      try {
        await prepare?.();
        if (cancelled || disposed) throw cancelledStart();
        const result = readDeviceStart(
          await request("auth.v1.deviceStart", { ...params, provider }),
        );
        if (cancelled || disposed) throw cancelledStart();
        if (
          !Number.isFinite(result.expiresIn) ||
          result.expiresIn <= 0 ||
          result.expiresIn > 3600 ||
          !Number.isFinite(result.interval) ||
          result.interval <= 0 ||
          result.interval > 300
        )
          throw new Error("The provider returned invalid sign-in timing.");
        const expiresAt = Date.now() + result.expiresIn * 1000;
        const view: MeerkatAuthFlow = {
          flowId: id,
          authorizeUrl: null,
          status: "waiting",
          message: null,
          userCode: result.userCode,
          verificationUri: result.verificationUri,
          verificationUriComplete: result.verificationUriComplete,
          expiresAt: new Date(expiresAt).toISOString(),
          intervalSeconds: result.interval,
        };
        deviceFlows.set(id, {
          owner,
          scope,
          cancellationScope,
          provider,
          request,
          params,
          deviceCode: result.deviceCode,
          view,
          expiresAt,
          pollAfter: Date.now() + result.interval * 1000,
          polling: false,
          ...(onConnected ? { onConnected } : {}),
        });
        return view;
      } finally {
        if (pendingStarts.get(id) === pending) pendingStarts.delete(id);
      }
    },
    async pollDevice(id: string | undefined, owner: string, scope: string, provider: string) {
      const flow = getDevice(id, owner, scope, provider);
      if (flow.view.status !== "waiting" || flow.polling) return flow.view;
      if (Date.now() >= flow.expiresAt) {
        flow.view = { ...flow.view, status: "failed", message: "Sign-in expired. Start again." };
        flow.deviceCode = "";
        return flow.view;
      }
      if (Date.now() < flow.pollAfter) return flow.view;
      flow.polling = true;
      try {
        const result = decodeDevicePoll(
          await flow.request("auth.v1.devicePoll", {
            ...flow.params,
            provider,
            deviceCode: flow.deviceCode,
          }),
        );
        const interval = result.retryAfterSeconds ?? flow.view.intervalSeconds ?? 5;
        if (!Number.isFinite(interval) || interval <= 0 || interval > 300)
          throw new Error("The provider returned invalid sign-in timing.");
        flow.pollAfter = Date.now() + interval * 1000;
        flow.view = {
          ...flow.view,
          status: result.status,
          intervalSeconds: interval,
          message:
            result.status === "connected"
              ? result.defaultActivation?.status === "needs_selection"
                ? "Signed in. Choose a default account in Providers to use its models."
                : "Signed in."
              : result.status === "failed"
                ? "Sign-in failed. Start again."
                : null,
          ...(result.status === "connected" && result.defaultActivation
            ? { defaultActivation: result.defaultActivation }
            : {}),
        };
        if (result.status !== "waiting") flow.deviceCode = "";
        if (result.status === "connected") {
          try {
            await flow.onConnected?.();
          } catch {
            flow.view = {
              ...flow.view,
              message: "Signed in. Refresh accounts to update model availability.",
            };
          }
        }
        return flow.view;
      } catch {
        // Native request and schema diagnostics must not return deviceCode to clients.
        throw new Error("Could not check device sign-in. Try again.");
      } finally {
        flow.polling = false;
      }
    },
    async start(
      owner: string,
      scope: string,
      provider: string,
      request: Request,
      params: Record<string, unknown>,
      onConnected?: () => Promise<void>,
      cancellationScope = scope,
      prepare?: () => Promise<CallbackPolicy | void>,
    ): Promise<MeerkatAuthFlow> {
      if (disposed) throw new Error("Provider sign-in is unavailable.");
      if (logouts.has(accountKey(cancellationScope, provider)))
        throw new Error("Sign-out is in progress. Wait before starting a new sign-in.");
      for (const [id, existing] of deviceFlows) {
        if (
          existing.owner === owner &&
          existing.scope === scope &&
          existing.provider === provider
        ) {
          if (existing.polling) throw new Error("Sign-in is completing. Refresh its status.");
          deviceFlows.delete(id);
        }
      }
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
      if (flows.size + deviceFlows.size + pendingStarts.size >= 128)
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
        const preparedCallback = await prepare?.();
        assertCurrent();
        // Real account starts supply the native method's callback contract in preflight.
        const callback = readCallbackPolicy(
          preparedCallback === undefined ? defaultCallbackPolicy : preparedCallback,
        );
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
                ? "Signed in. You may close this tab and return to the app."
                : "Sign-in was not completed. Return to the app.",
            );
          } catch {
            res.writeHead(400);
            res.end("This callback does not match the pending sign-in.");
          }
        });
        server = listener;
        for (const port of callback.ports) {
          assertCurrent();
          try {
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
              // Native redirects may advertise localhost but bind IPv4 loopback explicitly.
              listener.listen(port, "127.0.0.1");
            });
            break;
          } catch {
            assertCurrent();
          }
        }
        assertCurrent();
        const address = listener.address();
        if (!address || typeof address === "string") {
          if (callback.ports.every((port) => port !== 0))
            throw new Error(
              `Could not open the sign-in callback on the required local ports (${callback.ports.join(", ")}). Finish any other sign-in using those ports and try again.`,
            );
          throw new Error("Could not open a local sign-in callback. Try again.");
        }
        const redirectUri = `http://${callback.redirectHost}:${address.port}${callback.path}`;
        const loginResult = await request("auth.v1.loginStart", {
          ...params,
          provider,
          redirectUri,
        });
        // A cancelled native start is only discarded locally. Never log out a newer sign-in.
        assertCurrent();
        const login = decodeLoginStart(loginResult);
        const expiresAt = new Date(Date.now() + browserFlowLifetimeMs).toISOString();
        const timer = setTimeout(() => {
          if (flow) {
            flow.expired = true;
            flow.view = { ...flow.view, authorizeUrl: null };
            close(flow);
            // A running native completion can still save credentials. Keep its
            // guard and readable status until readiness publication settles.
            if (flow.completing) return;
            if (flow.view.status === "waiting")
              flow.view = {
                ...flow.view,
                authorizeUrl: null,
                status: "failed",
                message: "Sign-in expired. Start again.",
              };
            retainTerminal(flow);
          }
        }, browserFlowLifetimeMs);
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
          view: {
            flowId: id,
            authorizeUrl: login.authorizeUrl,
            status: "waiting",
            message: null,
            expiresAt,
          },
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
      if (id && deviceFlows.has(id)) return getDevice(id, owner, scope, provider).view;
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
      const cancelled: MeerkatAuthFlow = {
        flowId: null,
        authorizeUrl: null,
        status: "cancelled",
        message: null,
      };
      // Repeated cancellation and dismissal after retention are safe no-ops.
      // Existing IDs still go through their owner, scope and provider checks.
      if (!id || (!flows.has(id) && !deviceFlows.has(id))) return cancelled;
      if (id && deviceFlows.has(id)) {
        const flow = getDevice(id, owner, scope, provider);
        if (flow.polling) throw new Error("Sign-in is completing. Refresh its status.");
        deviceFlows.delete(id);
        return cancelled;
      }
      const flow = get(id, owner, scope, provider);
      if (flow.completing) throw new Error("Sign-in is completing. Refresh its status.");
      clearTimeout(flow.timer);
      close(flow);
      flows.delete(id!);
      return cancelled;
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
      deviceFlows.clear();
    },
  };
}
