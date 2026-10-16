// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - this Node transport owns the stdio child and its bounded request/shutdown timers; the driver supplies its Effect scope.
import * as NodeChildProcess from "node:child_process";

export interface MeerkatGatewayEvent {
  readonly event_id: string;
  readonly kind: string;
  readonly timestamp: string;
  readonly thread_id?: string;
  readonly run_id?: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly trace_id: string;
}

export class MeerkatGatewayRpcError extends Error {
  override readonly name = "MeerkatGatewayRpcError";
  readonly rpcCode: number;
  readonly typedCode: string;
  readonly traceId: string | undefined;
  readonly details: unknown;

  constructor(input: {
    readonly message: string;
    readonly rpcCode: number;
    readonly typedCode: string;
    readonly traceId?: string;
    readonly details?: unknown;
  }) {
    const nativeError = isRecord(input.details) ? input.details.error : undefined;
    // Preserve the native failure in normal cause rendering without logging the whole payload.
    super(
      input.message,
      typeof nativeError === "string" && nativeError.length > 0
        ? { cause: new Error(nativeError) }
        : undefined,
    );
    this.rpcCode = input.rpcCode;
    this.typedCode = input.typedCode;
    this.traceId = input.traceId;
    this.details = input.details;
  }
}

export class MeerkatGatewayTransportError extends Error {
  override readonly name = "MeerkatGatewayTransportError";
  readonly kind: string;
  /** A sent request may have executed even when its response was lost. Never replay it. */
  readonly outcomeUnknown: boolean;
  readonly details: unknown;

  constructor(kind: string, message: string, outcomeUnknown = false, details?: unknown) {
    super(message);
    this.kind = kind;
    this.outcomeUnknown = outcomeUnknown;
    this.details = details;
  }
}

export interface MeerkatGatewayClientOptions {
  readonly binaryPath: string;
  readonly args?: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly requestTimeoutMs?: number;
  readonly maxFrameBytes?: number;
  readonly shutdownTimeoutMs?: number;
}

export interface MeerkatGatewayRequestOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface MeerkatGatewayClient {
  readonly pid: number | undefined;
  readonly request: (
    method: string,
    params?: Readonly<Record<string, unknown>>,
    options?: MeerkatGatewayRequestOptions,
  ) => Promise<unknown>;
  readonly subscribe: (listener: (event: MeerkatGatewayEvent) => void) => () => void;
  readonly onClose: (listener: (error: MeerkatGatewayTransportError) => void) => () => void;
  readonly close: () => Promise<void>;
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly cleanup: () => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function shutdownTrigger(value: unknown) {
  if (!isRecord(value)) return undefined;
  if (value.kind === "stdin_eof" || value.kind === "sigint" || value.kind === "sigterm") {
    return { kind: value.kind };
  }
  if (value.kind !== "stdin_error") return undefined;
  return {
    kind: value.kind,
    // Native ErrorKind is an enum identifier, never an error message or path.
    ...(typeof value.errorKind === "string" && /^[A-Za-z]{1,48}$/.test(value.errorKind)
      ? { errorKind: value.errorKind }
      : {}),
    ...(value.rawOsError === null ||
    (typeof value.rawOsError === "number" && Number.isSafeInteger(value.rawOsError))
      ? { rawOsError: value.rawOsError }
      : {}),
  };
}

export function decodeMeerkatGatewayEvent(value: unknown): MeerkatGatewayEvent {
  if (
    !isRecord(value) ||
    typeof value.event_id !== "string" ||
    typeof value.kind !== "string" ||
    typeof value.timestamp !== "string" ||
    typeof value.trace_id !== "string" ||
    !isRecord(value.payload) ||
    (value.thread_id !== undefined && typeof value.thread_id !== "string") ||
    (value.run_id !== undefined && typeof value.run_id !== "string")
  ) {
    throw new MeerkatGatewayTransportError("protocol_error", "Invalid Meerkat gateway event.");
  }
  return {
    event_id: value.event_id,
    kind: value.kind,
    timestamp: value.timestamp,
    trace_id: value.trace_id,
    payload: value.payload,
    ...(typeof value.thread_id === "string" ? { thread_id: value.thread_id } : {}),
    ...(typeof value.run_id === "string" ? { run_id: value.run_id } : {}),
  };
}

/** One owned subprocess. Connection failure is terminal; reconnecting never resends requests. */
export function createMeerkatGatewayClient(
  options: MeerkatGatewayClientOptions,
): MeerkatGatewayClient {
  const maxFrameBytes = options.maxFrameBytes ?? 14 * 1024 * 1024;
  const requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
  const child = NodeChildProcess.spawn(options.binaryPath, [...(options.args ?? [])], {
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
  });
  const pending = new Map<number, PendingRequest>();
  const listeners = new Set<(event: MeerkatGatewayEvent) => void>();
  const closeListeners = new Set<(error: MeerkatGatewayTransportError) => void>();
  let nextId = 1;
  let buffer = Buffer.alloc(0);
  let failure: MeerkatGatewayTransportError | undefined;
  let closing = false;
  // Native runtime shutdown publishes a 312-second horizon. Health can
  // advertise a larger embedder budget as that contract evolves.
  let shutdownTimeoutMs = options.shutdownTimeoutMs ?? 342_000;
  let closePromise: Promise<void> | undefined;
  let shutdownError: Error | undefined;
  let spawnFailedWithoutChild = false;
  let cleanupConfirmed = false;
  let nativeShutdown:
    | { cleanupCompleted: boolean; trigger: ReturnType<typeof shutdownTrigger> }
    | undefined;
  let closeResolved = false;
  let resolveClose: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    resolveClose = resolve;
  });

  const finishPending = (id: number): PendingRequest | undefined => {
    const entry = pending.get(id);
    if (entry) {
      pending.delete(id);
      entry.cleanup();
    }
    return entry;
  };
  const cancelWritingRequest = (id: number) => {
    if (failure || closing || pending.get(id)?.method !== "text.v1.generate") return;
    // Only tool-free writing supports transport cancellation. Stateful agent
    // requests retain their uncertain-outcome contract and are never replayed.
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "text.v1.cancel", params: { requestId: id } })}\n`,
    );
  };
  const fail = (error: MeerkatGatewayTransportError) => {
    if (failure) return;
    failure = error;
    // A transport failure before or during disposal is not proof of cleanup.
    // Keep the first failure for every later close caller.
    if (error.kind !== "closed") shutdownError ??= error;
    for (const [id] of pending) {
      finishPending(id)?.reject(
        new MeerkatGatewayTransportError(error.kind, error.message, true, error.details),
      );
    }
    for (const listener of closeListeners) listener(error);
    closeListeners.clear();
    listeners.clear();
  };
  const protocolFailure = (message: string) => {
    fail(new MeerkatGatewayTransportError("protocol_error", message));
    child.kill("SIGTERM");
  };
  const receive = (line: Buffer) => {
    if (failure || line.length === 0) return;
    let message: unknown;
    try {
      message = JSON.parse(line.toString("utf8"));
    } catch {
      protocolFailure("Meerkat gateway emitted invalid JSON.");
      return;
    }
    if (!isRecord(message) || message.jsonrpc !== "2.0") {
      protocolFailure("Meerkat gateway emitted an invalid JSON-RPC frame.");
      return;
    }
    if (message.method === "system.v1.shutdownComplete") {
      if (isRecord(message.params)) {
        nativeShutdown = {
          cleanupCompleted: message.params.cleanupCompleted === true,
          trigger: shutdownTrigger(message.params.trigger),
        };
      }
      if (!isRecord(message.params) || message.params.cleanupCompleted !== true) {
        shutdownError ??= new MeerkatGatewayTransportError(
          "cleanup_failed",
          "Meerkat native cleanup did not complete.",
          false,
          message.params,
        );
      } else cleanupConfirmed = true;
      return;
    }
    if (message.method === "events.v1.emit") {
      let event: MeerkatGatewayEvent;
      try {
        event = decodeMeerkatGatewayEvent(message.params);
      } catch {
        protocolFailure("Meerkat gateway emitted an invalid event.");
        return;
      }
      for (const listener of listeners) listener(event);
      return;
    }
    // Unconfigured host tools cannot execute. Other notifications are deliberately not requests.
    if (typeof message.method === "string" && message.id === undefined) return;
    if (typeof message.id !== "number") {
      protocolFailure("Meerkat gateway response has no request identity.");
      return;
    }
    const entry = finishPending(message.id);
    if (!entry) return;
    if (isRecord(message.error)) {
      const data = isRecord(message.error.data) ? message.error.data : {};
      entry.reject(
        new MeerkatGatewayRpcError({
          message:
            typeof message.error.message === "string"
              ? message.error.message
              : "Meerkat gateway request failed.",
          rpcCode: typeof message.error.code === "number" ? message.error.code : -32603,
          typedCode: typeof data.code === "string" ? data.code : "INTERNAL_ERROR",
          ...(typeof data.trace_id === "string" ? { traceId: data.trace_id } : {}),
          details: data.details,
        }),
      );
    } else if (Object.hasOwn(message, "result")) {
      if (
        isRecord(message.result) &&
        typeof message.result.shutdownHorizonMs === "number" &&
        Number.isFinite(message.result.shutdownHorizonMs) &&
        message.result.shutdownHorizonMs > 0 &&
        options.shutdownTimeoutMs === undefined
      ) {
        shutdownTimeoutMs = Math.max(shutdownTimeoutMs, message.result.shutdownHorizonMs + 15_000);
      }
      entry.resolve(message.result);
    } else {
      entry.reject(
        new MeerkatGatewayTransportError("protocol_error", "Gateway response has no result.", true),
      );
      protocolFailure("Gateway response has no result.");
    }
  };

  child.stdout.on("data", (chunk: Buffer) => {
    if (failure) return;
    buffer = Buffer.concat([buffer, chunk]);
    let newline: number;
    while ((newline = buffer.indexOf(10)) !== -1) {
      if (newline > maxFrameBytes) {
        protocolFailure("Meerkat gateway response exceeded the frame limit.");
        return;
      }
      const line = buffer.subarray(0, newline);
      buffer = buffer.subarray(newline + 1);
      receive(line);
      if (failure) return;
    }
    if (buffer.length > maxFrameBytes) {
      protocolFailure("Meerkat gateway response exceeded the frame limit.");
    }
  });
  // Drain diagnostics without putting provider output or filesystem paths into application logs.
  child.stderr.resume();
  child.stdin.on("error", () => {
    fail(new MeerkatGatewayTransportError("write_failed", "Meerkat gateway input closed."));
  });
  child.on("error", (error: Error) => {
    // A failed spawn owns no process or native work. Preserve its request error,
    // but let disposal finish so correcting the executable can rebuild it.
    if (child.pid === undefined) spawnFailedWithoutChild = true;
    fail(
      new MeerkatGatewayTransportError(
        "spawn_failed",
        `Cannot start Meerkat gateway: ${error.message}`,
      ),
    );
  });
  child.on("close", (code, signal) => {
    if (closing && !failure) {
      if (signal || code !== 0) {
        shutdownError ??= new MeerkatGatewayTransportError(
          "cleanup_failed",
          `Meerkat exited before clean shutdown (${signal ?? code ?? "unknown"}).`,
        );
      } else if (!cleanupConfirmed) {
        shutdownError ??= new MeerkatGatewayTransportError(
          "cleanup_failed",
          "Meerkat exited without confirming native cleanup.",
        );
      }
    }
    if (!failure) {
      fail(
        new MeerkatGatewayTransportError(
          closing ? "closed" : "process_exited",
          closing
            ? "Meerkat gateway connection closed."
            : `Meerkat gateway exited (${signal ?? code ?? "unknown"}).`,
          false,
          nativeShutdown,
        ),
      );
    }
    closeResolved = true;
    resolveClose();
  });

  return {
    get pid() {
      return child.pid;
    },
    request(method, params = {}, requestOptions = {}) {
      if (failure || closing) {
        return Promise.reject(
          failure ?? new MeerkatGatewayTransportError("closed", "Meerkat gateway is closing."),
        );
      }
      if (requestOptions.signal?.aborted) {
        return Promise.reject(
          new MeerkatGatewayTransportError(
            "request_aborted",
            "Gateway request was aborted before send.",
          ),
        );
      }
      const id = nextId++;
      let encoded: string;
      try {
        encoded = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
      } catch {
        return Promise.reject(
          new MeerkatGatewayTransportError(
            "invalid_request",
            "Gateway request is not JSON serializable.",
          ),
        );
      }
      const requestLimit =
        method === "mobs.v1.imageUpload"
          ? 14 * 1024 * 1024
          : method === "desktop.hostTools.complete.v1"
            ? 6 * 1024 * 1024
            : 256 * 1024;
      if (Buffer.byteLength(encoded) - 1 > requestLimit) {
        return Promise.reject(
          new MeerkatGatewayTransportError(
            "invalid_request",
            "Gateway request exceeded the frame limit.",
          ),
        );
      }
      return new Promise((resolve, reject) => {
        const rejectWaiting = (kind: string, message: string) => {
          finishPending(id)?.reject(new MeerkatGatewayTransportError(kind, message, true));
        };
        const timeout = setTimeout(() => {
          cancelWritingRequest(id);
          rejectWaiting(
            "request_timeout",
            `Meerkat gateway request timed out: ${method}. Execution outcome is unknown.`,
          );
        }, requestOptions.timeoutMs ?? requestTimeoutMs);
        const abort = () => {
          cancelWritingRequest(id);
          rejectWaiting(
            "request_aborted",
            "Stopped awaiting gateway response. Execution outcome is unknown.",
          );
        };
        requestOptions.signal?.addEventListener("abort", abort, { once: true });
        pending.set(id, {
          method,
          resolve,
          reject,
          cleanup() {
            clearTimeout(timeout);
            requestOptions.signal?.removeEventListener("abort", abort);
          },
        });
        child.stdin.write(encoded, (error) => {
          if (error)
            rejectWaiting(
              "write_failed",
              "Failed to send gateway request. Execution outcome is unknown.",
            );
        });
      });
    },
    subscribe(listener) {
      if (!failure) listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onClose(listener) {
      if (failure) listener(failure);
      else closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    close() {
      if (closePromise) return closePromise;
      if (closeResolved) {
        closePromise =
          shutdownError && !spawnFailedWithoutChild
            ? Promise.reject(shutdownError)
            : Promise.resolve();
        return closePromise;
      }
      for (const [id] of pending) cancelWritingRequest(id);
      closing = true;
      child.stdin.end();
      closePromise = (async () => {
        // EOF is the graceful shutdown request. Keep consuming responses and
        // terminal events until native cleanup finishes before escalation.
        const terminate = setTimeout(() => {
          shutdownError ??= new MeerkatGatewayTransportError(
            "cleanup_timeout",
            "Meerkat exceeded its native shutdown horizon.",
          );
          child.kill("SIGTERM");
        }, shutdownTimeoutMs);
        const kill = setTimeout(() => child.kill("SIGKILL"), shutdownTimeoutMs + 5_000);
        try {
          await closed;
          if (shutdownError && !spawnFailedWithoutChild) throw shutdownError;
        } finally {
          clearTimeout(terminate);
          clearTimeout(kill);
        }
      })();
      return closePromise;
    },
  };
}
