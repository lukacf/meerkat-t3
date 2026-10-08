import {
  DesktopBackendBootstrap,
  type DesktopBackendBootstrap as DesktopBackendBootstrapValue,
  DesktopTelemetryControlMessage,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as DesktopBackendManager from "./DesktopBackendManager.ts";
import * as DesktopApp from "../app/DesktopApp.ts";
import * as DesktopBackendPool from "./DesktopBackendPool.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";
import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";

const decodeDesktopBackendBootstrap = Schema.decodeEffect(
  Schema.fromJsonString(DesktopBackendBootstrap),
);
const isBackendProcessError = Schema.is(DesktopBackendManager.BackendProcessError);
const encodeDesktopTelemetryControl = Schema.encodeSync(
  Schema.fromJsonString(DesktopTelemetryControlMessage),
);

const baseConfig: DesktopBackendManager.DesktopBackendStartConfig = {
  executablePath: "/electron",
  args: ["/server/bin.mjs", "--bootstrap-fd", "3"],
  entryPath: "/server/bin.mjs",
  cwd: "/server",
  env: { ELECTRON_RUN_AS_NODE: "1" },
  bootstrap: {
    mode: "desktop",
    noBrowser: true,
    port: 3773,
    t3Home: "/tmp/t3",
    host: "127.0.0.1",
    desktopBootstrapToken: "token",
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
    desktopTelemetryFd: 4,
    desktopTelemetryControlFd: 5,
  },
  bootstrapDelivery: "fd3",
  extendEnv: true,
  httpBaseUrl: new URL("http://127.0.0.1:3773"),
  captureOutput: true,
  preflightFailure: Option.none(),
};

const configWithObservability: DesktopBackendBootstrapValue = {
  ...baseConfig.bootstrap,
  tailscaleServeEnabled: true,
  desktopTelemetryFd: 4,
  otlpTracesUrl: "http://127.0.0.1:4318/v1/traces",
};

function makeProcess(options?: {
  readonly stdout?: Stream.Stream<Uint8Array, PlatformError.PlatformError>;
  readonly stderr?: Stream.Stream<Uint8Array, PlatformError.PlatformError>;
  readonly exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode, PlatformError.PlatformError>;
  readonly isRunning?: Effect.Effect<boolean, PlatformError.PlatformError>;
  readonly kill?: ChildProcessSpawner.ChildProcessHandle["kill"];
  readonly getInputFd?: ChildProcessSpawner.ChildProcessHandle["getInputFd"];
  readonly getOutputFd?: ChildProcessSpawner.ChildProcessHandle["getOutputFd"];
}): ChildProcessSpawner.ChildProcessHandle {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: options?.stdout ?? Stream.empty,
    stderr: options?.stderr ?? Stream.empty,
    all: Stream.merge(options?.stdout ?? Stream.empty, options?.stderr ?? Stream.empty),
    exitCode: options?.exitCode ?? Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: options?.isRunning ?? Effect.succeed(false),
    kill: options?.kill ?? (() => Effect.void),
    stdin: Sink.drain,
    getInputFd: options?.getInputFd ?? (() => Sink.drain),
    getOutputFd: options?.getOutputFd ?? (() => Stream.empty),
    unref: Effect.succeed(Effect.void),
  });
}

function responseForRequest(
  request: HttpClientRequest.HttpClientRequest,
  status: number,
): HttpClientResponse.HttpClientResponse {
  return HttpClientResponse.fromWeb(request, new Response(null, { status }));
}

function httpClientLayer(
  handler: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse>,
) {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => handler(request)),
  );
}

const healthyHttpClientLayer = httpClientLayer((request) =>
  Effect.succeed(responseForRequest(request, 200)),
);

function decodeBootstrap(raw: string) {
  return decodeDesktopBackendBootstrap(raw);
}

interface MakeInstanceInput {
  readonly spawnerLayer: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>;
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>;
  readonly backendOutputLog?: Partial<DesktopObservability.DesktopBackendOutputLogShape>;
  readonly onReady?: Effect.Effect<void>;
  readonly onShutdown?: Effect.Effect<void>;
  readonly onPreflightFailed?: (
    failure: DesktopBackendManager.PreflightFailure,
  ) => Effect.Effect<boolean>;
  readonly config?: DesktopBackendManager.DesktopBackendStartConfig;
  readonly configResolve?: Effect.Effect<
    DesktopBackendManager.DesktopBackendStartConfig,
    PlatformError.PlatformError
  >;
  readonly desktopTelemetryStream?: Stream.Stream<Uint8Array>;
  readonly desktopTelemetryPublisher?: Partial<
    DesktopTelemetryPublisher.DesktopTelemetryPublisher["Service"]
  >;
  readonly pruneRuntimes?: (distro: string | null, runtimeId: string) => Effect.Effect<void>;
}

// Helper that constructs a primary backend instance using the factory
// directly. The factory's deps (FileSystem, ChildProcessSpawner,
// HttpClient, DesktopBackendOutputLogFactory) are provided per-test via
// a scoped layer; tests yield the returned Effect inside `Effect.scoped`
// to drive the instance's lifecycle.
function makeTestInstance(input: MakeInstanceInput) {
  const stubLog: DesktopObservability.DesktopBackendOutputLogShape = {
    beginSession: () => Effect.void,
    writeOutputChunk: () => Effect.void,
    persistFailureSnapshot: () => Effect.void,
    persistFailure: () => Effect.void,
    discardSession: Effect.void,
    ...input.backendOutputLog,
  };
  const servicesLayer = Layer.mergeAll(
    FileSystem.layerNoop({
      exists: () => Effect.succeed(true),
    }),
    input.spawnerLayer,
    input.httpClientLayer ?? healthyHttpClientLayer,
    Layer.succeed(DesktopObservability.DesktopBackendOutputLogFactory, {
      forInstance: () => Effect.succeed(stubLog),
    } satisfies DesktopObservability.DesktopBackendOutputLogFactory["Service"]),
    Layer.succeed(DesktopTelemetryPublisher.DesktopTelemetryPublisher, {
      latest: Effect.succeedNone,
      changes: Stream.empty,
      encoded: input.desktopTelemetryStream ?? Stream.empty,
      handleControlForSource: () => Effect.void,
      removeControlSource: () => Effect.void,
      publishUpdateReport: () => Effect.void,
      updateRequests: Stream.empty,
      updateCommits: Stream.empty,
      updateCancellations: Stream.empty,
      ...input.desktopTelemetryPublisher,
    }),
    DesktopWslEnvironment.layerTest(
      input.pruneRuntimes === undefined ? {} : { pruneRuntimes: input.pruneRuntimes },
    ),
  );

  const instance = DesktopBackendManager.makeBackendInstance({
    id: DesktopBackendManager.PRIMARY_INSTANCE_ID,
    label: Effect.succeed("Windows"),
    configResolve: input.configResolve ?? Effect.succeed(input.config ?? baseConfig),
    ...(input.onReady ? { onReady: () => input.onReady! } : {}),
    ...(input.onShutdown ? { onShutdown: () => input.onShutdown! } : {}),
    ...(input.onPreflightFailed ? { onPreflightFailed: input.onPreflightFailed } : {}),
  });

  return instance.pipe(Effect.provide(servicesLayer));
}

describe("DesktopBackendManager", () => {
  it.effect("spawns the backend with fd3 bootstrap and fd4 telemetry", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let spawnedCommand: ChildProcess.Command | undefined;
        let bootstrapJson = "";
        let telemetryJson = "";
        let readyCount = 0;
        const ready = yield* Deferred.make<void>();
        const telemetryRead = yield* Deferred.make<void>();
        const exited = yield* Queue.unbounded<void>();

        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) =>
            Effect.gen(function* () {
              spawnedCommand = command;
              if (command._tag === "StandardCommand") {
                const fd3 = command.options.additionalFds?.fd3;
                if (fd3?.type === "input" && fd3.stream) {
                  bootstrapJson = yield* fd3.stream.pipe(Stream.decodeText(), Stream.mkString);
                }
              }

              return makeProcess({
                getInputFd: () =>
                  Sink.forEach((chunk: Uint8Array) =>
                    Effect.sync(() => {
                      telemetryJson += new TextDecoder().decode(chunk);
                    }),
                  ).pipe(
                    Sink.mapEffect(() =>
                      Deferred.succeed(telemetryRead, undefined).pipe(Effect.asVoid),
                    ),
                  ),
                exitCode: Deferred.await(ready).pipe(
                  Effect.andThen(Deferred.await(telemetryRead)),
                  Effect.as(ChildProcessSpawner.ExitCode(0)),
                ),
              });
            }),
          ),
        );

        const instance = yield* makeTestInstance({
          config: {
            ...baseConfig,
            bootstrap: configWithObservability,
          },
          spawnerLayer,
          desktopTelemetryStream: Stream.encodeText(
            Stream.make('{"version":1,"type":"desktopTelemetryHello","electronPid":123}\n'),
          ),
          onReady: Effect.sync(() => {
            readyCount += 1;
          }).pipe(Effect.andThen(Deferred.succeed(ready, void 0)), Effect.asVoid),
          backendOutputLog: {
            persistFailure: () => Queue.offer(exited, void 0).pipe(Effect.asVoid),
          },
        });

        yield* instance.start;
        yield* Queue.take(exited);

        assert.equal(readyCount, 1);
        assert.isDefined(spawnedCommand);
        if (spawnedCommand._tag !== "StandardCommand") {
          throw new Error("Expected backend to spawn a standard command.");
        }

        assert.equal(spawnedCommand.command, "/electron");
        assert.deepEqual(spawnedCommand.args, ["/server/bin.mjs", "--bootstrap-fd", "3"]);
        assert.equal(spawnedCommand.options.cwd, "/server");
        assert.equal(spawnedCommand.options.extendEnv, true);
        assert.equal(spawnedCommand.options.stdout, "pipe");
        assert.equal(spawnedCommand.options.stderr, "pipe");
        assert.equal(spawnedCommand.options.killSignal, "SIGTERM");
        assert.isDefined(spawnedCommand.options.forceKillAfter);
        assert.equal(spawnedCommand.options.additionalFds?.fd4?.type, "input");
        assert.equal(spawnedCommand.options.additionalFds?.fd5?.type, "output");
        assert.notProperty(spawnedCommand.options.additionalFds, "fd6");
        assert.equal(
          Duration.toMillis(Duration.fromInputUnsafe(spawnedCommand.options.forceKillAfter)),
          2_000,
        );

        assert.deepEqual(yield* decodeBootstrap(bootstrapJson), configWithObservability);
        assert.equal(
          telemetryJson,
          '{"version":1,"type":"desktopTelemetryHello","electronPid":123}\n',
        );
      }),
    ),
  );

  it.effect("preserves the readiness timeout cause and process context", () =>
    Effect.gen(function* () {
      const requested = yield* Deferred.make<HttpClientRequest.HttpClientRequest>();
      const layer = Layer.merge(
        TestClock.layer(),
        httpClientLayer((request) =>
          Deferred.succeed(requested, request).pipe(Effect.andThen(Effect.never)),
        ),
      );

      yield* Effect.gen(function* () {
        const readiness = yield* DesktopBackendManager.waitForHttpReady({
          executablePath: baseConfig.executablePath,
          entryPath: baseConfig.entryPath,
          cwd: baseConfig.cwd,
          httpBaseUrl: baseConfig.httpBaseUrl,
          timeout: Duration.millis(50),
        }).pipe(Effect.flip, Effect.forkChild);

        const request = yield* Deferred.await(requested);
        assert.equal(request.url, "http://127.0.0.1:3773/.well-known/t3/environment");

        yield* TestClock.adjust(Duration.millis(50));
        const error = yield* Fiber.join(readiness);

        assert.instanceOf(error, DesktopBackendManager.BackendReadinessTimeoutError);
        assert.equal(error.executablePath, "/electron");
        assert.equal(error.entryPath, "/server/bin.mjs");
        assert.equal(error.cwd, "/server");
        assert.equal(error.httpBaseUrl.href, "http://127.0.0.1:3773/");
        assert.equal(error.readinessUrl.href, "http://127.0.0.1:3773/.well-known/t3/environment");
        assert.equal(error.timeoutMs, 50);
        assert.isDefined(error.cause);
        assert.equal(
          error.message,
          "Timed out after 50ms waiting for desktop backend readiness at http://127.0.0.1:3773/.well-known/t3/environment.",
        );
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("reports bootstrap encoding failures with stable process context", () =>
    Effect.gen(function* () {
      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.die("unexpected backend spawn")),
      );
      const error = yield* DesktopBackendManager.runBackendProcess({
        ...baseConfig,
        desktopTelemetryStream: Stream.empty,
        bootstrap: {
          ...baseConfig.bootstrap,
          port: 0,
        },
      }).pipe(
        Effect.flip,
        Effect.scoped,
        Effect.provide(Layer.merge(spawnerLayer, healthyHttpClientLayer)),
      );

      if (error._tag !== "BackendProcessBootstrapEncodeError") {
        return assert.fail(`Expected bootstrap encode error, received ${error._tag}`);
      }
      assert.equal(error.executablePath, "/electron");
      assert.equal(error.entryPath, "/server/bin.mjs");
      assert.equal(error.cwd, "/server");
      assert.equal(error.httpBaseUrl.href, "http://127.0.0.1:3773/");
      assert.isDefined(error.cause);
      assert.equal(
        error.message,
        "Failed to encode the desktop backend bootstrap payload for /server/bin.mjs.",
      );
      assert.isTrue(isBackendProcessError(error));
    }),
  );

  it.effect("preserves spawn failures without deriving their message from the cause", () =>
    Effect.gen(function* () {
      const spawnCause = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "ChildProcessSpawner",
        method: "spawn",
        pathOrDescriptor: baseConfig.executablePath,
        description: "low-level detail that must not become the public message",
      });
      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.fail(spawnCause)),
      );
      const error = yield* DesktopBackendManager.runBackendProcess({
        ...baseConfig,
        desktopTelemetryStream: Stream.empty,
      }).pipe(
        Effect.flip,
        Effect.scoped,
        Effect.provide(Layer.merge(spawnerLayer, healthyHttpClientLayer)),
      );

      if (error._tag !== "BackendProcessSpawnError") {
        return assert.fail(`Expected backend spawn error, received ${error._tag}`);
      }
      assert.equal(error.executablePath, "/electron");
      assert.equal(error.entryPath, "/server/bin.mjs");
      assert.equal(error.cwd, "/server");
      assert.equal(error.httpBaseUrl.href, "http://127.0.0.1:3773/");
      assert.strictEqual(error.cause, spawnCause);
      assert.equal(
        error.message,
        "Failed to spawn desktop backend entry /server/bin.mjs with /electron.",
      );
      assert.notInclude(error.message, spawnCause.message);
      assert.isTrue(isBackendProcessError(error));
    }),
  );

  it.effect("preserves exit-status failures without copying their detail into the message", () =>
    Effect.gen(function* () {
      const exitCause = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "ChildProcess",
        method: "exitCode",
        description: "exit-status-secret-sentinel",
      });
      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.succeed(
            makeProcess({
              exitCode: Effect.fail(exitCause),
            }),
          ),
        ),
      );
      const error = yield* DesktopBackendManager.runBackendProcess({
        ...baseConfig,
        desktopTelemetryStream: Stream.empty,
      }).pipe(
        Effect.flip,
        Effect.scoped,
        Effect.provide(Layer.merge(spawnerLayer, healthyHttpClientLayer)),
      );

      if (error._tag !== "BackendProcessExitStatusError") {
        return assert.fail(`Expected backend exit-status error, received ${error._tag}`);
      }
      assert.equal(error.pid, 123);
      assert.equal(error.executablePath, "/electron");
      assert.equal(error.entryPath, "/server/bin.mjs");
      assert.equal(error.cwd, "/server");
      assert.equal(error.httpBaseUrl.href, "http://127.0.0.1:3773/");
      assert.strictEqual(error.cause, exitCause);
      assert.equal(error.message, "Failed to read the exit status of desktop backend process 123.");
      assert.notInclude(error.message, "exit-status-secret-sentinel");
      assert.isTrue(isBackendProcessError(error));
    }),
  );

  it.effect("reports output stream failures with process and stream context", () =>
    Effect.gen(function* () {
      const outputCause = PlatformError.systemError({
        _tag: "BadResource",
        module: "ChildProcess",
        method: "stdout",
        description: "output-stream-secret-sentinel",
      });
      const reported = yield* Deferred.make<DesktopBackendManager.BackendProcessOutputError>();
      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.succeed(
            makeProcess({
              stdout: Stream.fail(outputCause),
              exitCode: Deferred.await(reported).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
            }),
          ),
        ),
      );

      const exit = yield* DesktopBackendManager.runBackendProcess({
        ...baseConfig,
        desktopTelemetryStream: Stream.empty,
        onOutputFailure: (error) => Deferred.succeed(reported, error).pipe(Effect.asVoid),
      }).pipe(Effect.scoped, Effect.provide(Layer.merge(spawnerLayer, healthyHttpClientLayer)));
      const error = yield* Deferred.await(reported);

      assert.equal(exit.code.pipe(Option.getOrUndefined), 0);
      if (error._tag !== "BackendProcessOutputReadError") {
        return assert.fail(`Expected output read error, received ${error._tag}`);
      }
      assert.equal(error.executablePath, "/electron");
      assert.equal(error.entryPath, "/server/bin.mjs");
      assert.equal(error.cwd, "/server");
      assert.equal(error.httpBaseUrl.href, "http://127.0.0.1:3773/");
      assert.equal(error.pid, 123);
      assert.equal(error.streamName, "stdout");
      assert.strictEqual(error.cause, outputCause);
      assert.equal(error.message, "Failed to read stdout from desktop backend process 123.");
      assert.notInclude(error.message, "output-stream-secret-sentinel");
    }),
  );

  it.effect("reports output handler failures separately from stream read failures", () =>
    Effect.gen(function* () {
      const chunk = new TextEncoder().encode("backend output");
      const nextChunk = new TextEncoder().encode("still draining");
      const outputCause = new Error("output-handler-secret-sentinel");
      const reported = yield* Deferred.make<DesktopBackendManager.BackendProcessOutputError>();
      const drained = yield* Deferred.make<void>();
      let outputCount = 0;
      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.succeed(
            makeProcess({
              stdout: Stream.make(chunk, nextChunk),
              exitCode: Deferred.await(drained).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
            }),
          ),
        ),
      );

      const exit = yield* DesktopBackendManager.runBackendProcess({
        ...baseConfig,
        desktopTelemetryStream: Stream.empty,
        onOutput: () => {
          outputCount += 1;
          return outputCount === 1
            ? Effect.fail(outputCause)
            : Deferred.succeed(drained, void 0).pipe(Effect.asVoid);
        },
        onOutputFailure: (error) => Deferred.succeed(reported, error).pipe(Effect.asVoid),
      }).pipe(Effect.scoped, Effect.provide(Layer.merge(spawnerLayer, healthyHttpClientLayer)));
      const error = yield* Deferred.await(reported);

      assert.equal(exit.code.pipe(Option.getOrUndefined), 0);
      if (error._tag !== "BackendProcessOutputHandlingError") {
        return assert.fail(`Expected output handling error, received ${error._tag}`);
      }
      assert.equal(error.executablePath, "/electron");
      assert.equal(error.entryPath, "/server/bin.mjs");
      assert.equal(error.cwd, "/server");
      assert.equal(error.httpBaseUrl.href, "http://127.0.0.1:3773/");
      assert.equal(error.pid, 123);
      assert.equal(error.streamName, "stdout");
      assert.equal(error.chunkByteLength, chunk.byteLength);
      assert.strictEqual(error.cause, outputCause);
      assert.equal(
        error.message,
        `Failed to handle ${chunk.byteLength} bytes from stdout of desktop backend process 123.`,
      );
      assert.notInclude(error.message, "output-handler-secret-sentinel");
      assert.equal(outputCount, 2);
    }),
  );

  it.effect("keeps draining an observed exit when its process scope closes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processScope = yield* Scope.fork(yield* Scope.Scope);
        const exitObserved = yield* Deferred.make<void>();
        const finishOutputDrain = yield* Deferred.make<void>();
        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.succeed(
              makeProcess({
                stdout: Stream.fromEffect(
                  Deferred.await(finishOutputDrain).pipe(
                    Effect.as(new TextEncoder().encode("trailing output\n")),
                  ),
                ),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
              }),
            ),
          ),
        );

        const runFiber = yield* DesktopBackendManager.runBackendProcess({
          ...baseConfig,
          desktopTelemetryStream: Stream.empty,
          onExitObserved: () => Deferred.succeed(exitObserved, void 0).pipe(Effect.asVoid),
        }).pipe(
          Effect.provide(Layer.merge(spawnerLayer, healthyHttpClientLayer)),
          Scope.provide(processScope),
          Effect.forkChild,
        );

        yield* Deferred.await(exitObserved);
        yield* Scope.close(processScope, Exit.void);
        assert.isUndefined(runFiber.pollUnsafe());

        yield* Deferred.succeed(finishOutputDrain, void 0);
        assert.equal((yield* Fiber.join(runFiber)).code.pipe(Option.getOrUndefined), 1);
      }),
    ),
  );

  it.effect("does not advertise a parent lifetime descriptor through stdin bootstrap", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let bootstrapJson = "";
        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) =>
            Effect.gen(function* () {
              if (command._tag !== "StandardCommand" || !Stream.isStream(command.options.stdin)) {
                throw new Error("Expected a backend bootstrap stream on stdin.");
              }
              assert.isUndefined(command.options.additionalFds);
              bootstrapJson = yield* command.options.stdin.pipe(
                Stream.decodeText(),
                Stream.mkString,
              );
              return makeProcess({
                getInputFd: (fd) => {
                  assert.notEqual(fd, 6);
                  return Sink.drain;
                },
              });
            }),
          ),
        );
        yield* DesktopBackendManager.runBackendProcess({
          ...baseConfig,
          bootstrapDelivery: "stdin",
          bootstrap: { ...baseConfig.bootstrap, desktopParentLifetimeFd: 6 },
          desktopTelemetryStream: Stream.empty,
        }).pipe(Effect.provide(Layer.merge(spawnerLayer, healthyHttpClientLayer)));
        assert.notProperty(yield* decodeBootstrap(bootstrapJson), "desktopParentLifetimeFd");
      }),
    ),
  );

  it.effect("keeps the parent lifetime input open until backend scope shutdown", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processScope = yield* Scope.fork(yield* Scope.Scope);
        const started = yield* Deferred.make<void>();
        const lifetimeOpened = yield* Deferred.make<void>();
        const lifetimeEnded = yield* Deferred.make<void>();
        const telemetryEnded = yield* Deferred.make<void>();
        const signaled = yield* Deferred.make<void>();
        const events: Array<string> = [];
        let spawnedCommand: ChildProcess.Command | undefined;
        let lifetimeBytes = 0;
        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) =>
            Effect.gen(function* () {
              spawnedCommand = command;
              yield* Effect.addFinalizer(() => Effect.sync(() => events.push("group released")));
              return makeProcess({
                getInputFd: (fd) =>
                  fd === 6
                    ? Sink.unwrap(
                        Deferred.succeed(lifetimeOpened, undefined).pipe(
                          Effect.as(
                            Sink.forEach((chunk: Uint8Array) =>
                              Effect.sync(() => {
                                lifetimeBytes += chunk.byteLength;
                              }),
                            ).pipe(
                              Sink.mapEffect(() =>
                                Effect.sync(() => events.push("lifetime ended")).pipe(
                                  Effect.andThen(Deferred.succeed(lifetimeEnded, undefined)),
                                  Effect.asVoid,
                                ),
                              ),
                            ),
                          ),
                        ),
                      )
                    : Sink.drain.pipe(
                        Sink.mapEffect(() =>
                          Deferred.succeed(telemetryEnded, undefined).pipe(Effect.asVoid),
                        ),
                      ),
                exitCode: Deferred.await(signaled).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
                isRunning: Deferred.isDone(signaled).pipe(Effect.map((done) => !done)),
              });
            }),
          ),
        );
        const runFiber = yield* DesktopBackendManager.runBackendProcess({
          ...baseConfig,
          bootstrap: { ...baseConfig.bootstrap, desktopParentLifetimeFd: 6 },
          desktopTelemetryStream: Stream.empty,
          onStarted: () => Deferred.succeed(started, undefined).pipe(Effect.asVoid),
          signalShutdown: () =>
            Effect.sync(() => events.push("signal")).pipe(
              Effect.andThen(Deferred.succeed(signaled, undefined)),
              Effect.asVoid,
            ),
        }).pipe(
          Effect.provide(Layer.merge(spawnerLayer, healthyHttpClientLayer)),
          Scope.provide(processScope),
          Effect.forkChild,
        );
        yield* Deferred.await(started);
        assert.isDefined(spawnedCommand);
        if (spawnedCommand._tag !== "StandardCommand") {
          throw new Error("Expected backend to spawn a standard command.");
        }
        assert.deepEqual(spawnedCommand.options.additionalFds?.fd6, { type: "input" });
        yield* Deferred.await(lifetimeOpened);
        yield* Deferred.await(telemetryEnded);
        assert.isFalse(yield* Deferred.isDone(lifetimeEnded));
        assert.equal(lifetimeBytes, 0);

        yield* Scope.close(processScope, Exit.void);
        assert.equal(Option.getOrUndefined((yield* Fiber.join(runFiber)).code), 0);
        assert.isTrue(yield* Deferred.isDone(lifetimeEnded));
        assert.deepEqual(events, ["lifetime ended", "signal", "group released"]);
      }),
    ),
  );

  it.effect("ends only the stopping backend's telemetry input before signaling it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processScope = yield* Scope.fork(yield* Scope.Scope);
        const started = yield* Deferred.make<void>();
        const subscribed = yield* Deferred.make<void>();
        const inputEnded = yield* Deferred.make<void>();
        const signaled = yield* Deferred.make<void>();
        const publisher = yield* PubSub.unbounded<Uint8Array>();
        const otherBackend = yield* PubSub.subscribe(publisher);
        const events: Array<string> = [];
        const sharedStream = Stream.unwrap(
          PubSub.subscribe(publisher).pipe(
            Effect.tap(() => Deferred.succeed(subscribed, undefined)),
            Effect.map(Stream.fromSubscription),
          ),
        );
        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.gen(function* () {
              yield* Effect.addFinalizer(() => Effect.sync(() => events.push("group released")));
              return makeProcess({
                getInputFd: () =>
                  Sink.drain.pipe(
                    Sink.mapEffect(() =>
                      Effect.sync(() => events.push("input ended")).pipe(
                        Effect.andThen(Deferred.succeed(inputEnded, undefined)),
                        Effect.asVoid,
                      ),
                    ),
                  ),
                exitCode: Deferred.await(signaled).pipe(
                  Effect.andThen(Deferred.await(inputEnded)),
                  Effect.as(ChildProcessSpawner.ExitCode(0)),
                ),
                isRunning: Deferred.isDone(signaled).pipe(Effect.map((done) => !done)),
              });
            }),
          ),
        );
        const runFiber = yield* DesktopBackendManager.runBackendProcess({
          ...baseConfig,
          desktopTelemetryStream: sharedStream,
          onStarted: () => Deferred.succeed(started, undefined).pipe(Effect.asVoid),
          signalShutdown: () =>
            Effect.sync(() => events.push("signal")).pipe(
              Effect.andThen(Deferred.succeed(signaled, undefined)),
              Effect.asVoid,
            ),
        }).pipe(
          Effect.provide(Layer.merge(spawnerLayer, healthyHttpClientLayer)),
          Scope.provide(processScope),
          Effect.forkChild,
        );
        yield* Deferred.await(started);
        yield* Deferred.await(subscribed);
        // No new sample arrives. Closing must interrupt the blocked pull and
        // complete the sink normally, which is what sends descriptor EOF.
        yield* Scope.close(processScope, Exit.void);
        assert.equal(Option.getOrUndefined((yield* Fiber.join(runFiber)).code), 0);
        assert.deepEqual(events, ["input ended", "signal", "group released"]);

        const sample = new TextEncoder().encode("another backend is still subscribed\n");
        yield* PubSub.publish(publisher, sample);
        assert.deepEqual(yield* PubSub.take(otherBackend), sample);
      }),
    ),
  );

  it.effect("still signals the backend when its telemetry writer cannot drain", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processScope = yield* Scope.fork(yield* Scope.Scope);
        const started = yield* Deferred.make<void>();
        const writeBlocked = yield* Deferred.make<void>();
        const sourceEnded = yield* Deferred.make<void>();
        const signaled = yield* Deferred.make<void>();
        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.succeed(
              makeProcess({
                getInputFd: () =>
                  Sink.forEach(() =>
                    Deferred.succeed(writeBlocked, undefined).pipe(Effect.andThen(Effect.never)),
                  ),
                exitCode: Deferred.await(signaled).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
                isRunning: Deferred.isDone(signaled).pipe(Effect.map((done) => !done)),
              }),
            ),
          ),
        );
        const runFiber = yield* DesktopBackendManager.runBackendProcess({
          ...baseConfig,
          desktopTelemetryStream: Stream.make(new Uint8Array([1])).pipe(
            Stream.concat(Stream.never),
            Stream.ensuring(Deferred.succeed(sourceEnded, undefined)),
          ),
          onStarted: () => Deferred.succeed(started, undefined).pipe(Effect.asVoid),
          signalShutdown: () => Deferred.succeed(signaled, undefined).pipe(Effect.asVoid),
        }).pipe(
          Effect.provide(Layer.merge(spawnerLayer, healthyHttpClientLayer)),
          Scope.provide(processScope),
          Effect.forkChild,
        );
        yield* Deferred.await(started);
        yield* Deferred.await(writeBlocked);
        const closeFiber = yield* Scope.close(processScope, Exit.void).pipe(Effect.forkChild);
        yield* TestClock.adjust(Duration.seconds(1));
        yield* Deferred.await(signaled);
        yield* Fiber.join(closeFiber);
        assert.equal(Option.getOrUndefined((yield* Fiber.join(runFiber)).code), 0);
        yield* Deferred.await(sourceEnded);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("lets the backend finish native cleanup before releasing its process group", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processScope = yield* Scope.fork(yield* Scope.Scope);
        const started = yield* Deferred.make<void>();
        const signaled = yield* Deferred.make<void>();
        const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
        const events: Array<string> = [];
        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.gen(function* () {
              yield* Effect.addFinalizer(() => Effect.sync(() => events.push("group released")));
              return makeProcess({
                exitCode: Deferred.await(exited),
                isRunning: Deferred.isDone(exited).pipe(Effect.map((done) => !done)),
              });
            }),
          ),
        );
        const runFiber = yield* DesktopBackendManager.runBackendProcess({
          ...baseConfig,
          desktopTelemetryStream: Stream.empty,
          onStarted: () => Deferred.succeed(started, undefined).pipe(Effect.asVoid),
          signalShutdown: (pid) =>
            Effect.sync(() => events.push(`signal:${pid}`)).pipe(
              Effect.andThen(Deferred.succeed(signaled, undefined)),
              Effect.asVoid,
            ),
        }).pipe(
          Effect.provide(Layer.merge(spawnerLayer, healthyHttpClientLayer)),
          Scope.provide(processScope),
          Effect.forkChild,
        );
        yield* Deferred.await(started);
        const closeFiber = yield* Scope.close(processScope, Exit.void).pipe(Effect.forkChild);
        yield* Deferred.await(signaled);
        // Native cleanup may take 342s plus 5s of escalation. Neither the old
        // 2s process grace nor the old 5s application timeout may cut it short.
        yield* TestClock.adjust(Duration.seconds(348));
        assert.deepEqual(events, ["signal:123"]);
        assert.isUndefined(closeFiber.pollUnsafe());
        events.push("native cleanup complete");
        yield* Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0));
        yield* Fiber.join(closeFiber);
        assert.equal(Option.getOrUndefined((yield* Fiber.join(runFiber)).code), 0);
        assert.deepEqual(events, ["signal:123", "native cleanup complete", "group released"]);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect(
    "bounds a hung backend and retains incomplete cleanup after escalation exits zero",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const processScope = yield* Scope.fork(yield* Scope.Scope);
          const started = yield* Deferred.make<void>();
          const signaled = yield* Deferred.make<void>();
          const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
          const failures: Array<string> = [];
          let groupReleases = 0;
          const spawnerLayer = Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() =>
              Effect.gen(function* () {
                yield* Effect.addFinalizer(() =>
                  Effect.gen(function* () {
                    groupReleases += 1;
                    yield* Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0));
                  }),
                );
                return makeProcess({
                  exitCode: Deferred.await(exited),
                  isRunning: Deferred.isDone(exited).pipe(Effect.map((done) => !done)),
                });
              }),
            ),
          );
          const runFiber = yield* DesktopBackendManager.runBackendProcess({
            ...baseConfig,
            desktopTelemetryStream: Stream.empty,
            onStarted: () => Deferred.succeed(started, undefined).pipe(Effect.asVoid),
            signalShutdown: () => Deferred.succeed(signaled, undefined).pipe(Effect.asVoid),
            onShutdownFailure: (error) =>
              Effect.sync(() => {
                failures.push(error.message);
              }),
          }).pipe(
            Effect.provide(Layer.merge(spawnerLayer, healthyHttpClientLayer)),
            Scope.provide(processScope),
            Effect.exit,
            Effect.forkChild,
          );
          yield* Deferred.await(started);
          const closeFiber = yield* Scope.close(processScope, Exit.void).pipe(Effect.forkChild);
          yield* Deferred.await(signaled);
          yield* TestClock.adjust(Duration.minutes(10));
          yield* Fiber.join(closeFiber);
          assert.equal(groupReleases, 1);
          assert.equal(failures.length, 1);
          assert.include(failures[0]!, "cleanup is incomplete");
          assert.include(failures[0]!, "600000ms");
          const result = yield* Fiber.join(runFiber);
          assert.isTrue(Exit.isFailure(result));
          if (Exit.isFailure(result)) {
            assert.instanceOf(
              result.cause.reasons.find(Cause.isFailReason)?.error,
              DesktopBackendManager.BackendProcessShutdownError,
            );
          }
        }).pipe(Effect.provide(TestClock.layer())),
      ),
  );

  it.effect(
    "bounds a finalizer stop while retaining ownership until the backend really exits",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const spawned = yield* Deferred.make<void>();
          const teardownStarted = yield* Deferred.make<void>();
          const allowTeardown = yield* Deferred.make<void>();
          const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
          const failures: Array<string> = [];
          let spawnCount = 0;
          const instance = yield* makeTestInstance({
            spawnerLayer: Layer.succeed(
              ChildProcessSpawner.ChildProcessSpawner,
              ChildProcessSpawner.make(() =>
                Effect.gen(function* () {
                  spawnCount += 1;
                  yield* Effect.addFinalizer(() =>
                    Effect.gen(function* () {
                      yield* Deferred.succeed(teardownStarted, undefined);
                      // Models the spawner's exit wait after its group signals: it
                      // can remain pending even when its nominal grace has elapsed.
                      yield* Deferred.await(allowTeardown);
                      yield* Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0));
                    }),
                  );
                  yield* Deferred.succeed(spawned, undefined);
                  return makeProcess({ exitCode: Deferred.await(exited) });
                }),
              ),
            ),
            httpClientLayer: httpClientLayer(() => Effect.never),
            backendOutputLog: {
              persistFailureSnapshot: ({ details }) =>
                Effect.sync(() => {
                  failures.push(details);
                }),
            },
          });
          yield* instance.start;
          yield* Deferred.await(spawned);
          const quitting = yield* Effect.scoped(Effect.addFinalizer(() => instance.stop())).pipe(
            Effect.forkChild,
          );
          yield* Deferred.await(teardownStarted);
          yield* TestClock.adjust(Duration.minutes(11));
          yield* Fiber.join(quitting);
          const snapshot = yield* instance.snapshot;
          assert.equal(Option.getOrUndefined(snapshot.activePid), 123);
          assert.isFalse(snapshot.desiredRunning);
          assert.isFalse(snapshot.restartScheduled);
          assert.equal(failures.length, 1);
          assert.include(failures[0]!, "cleanup remains incomplete");
          yield* instance.start;
          assert.equal(spawnCount, 1);
          assert.equal(Option.getOrUndefined((yield* instance.snapshot).activePid), 123);

          // Finish the owned close before leaving this test's enclosing scope.
          yield* Deferred.succeed(allowTeardown, undefined);
          yield* instance.stop();
          assert.isTrue(Option.isNone((yield* instance.snapshot).activePid));
        }).pipe(Effect.provide(TestClock.layer())),
      ),
  );

  it.effect("does not report a process exit when the exit observer is interrupted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const observingExit = yield* Deferred.make<void>();
        let observedExits = 0;
        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.succeed(
              makeProcess({
                exitCode: Deferred.succeed(observingExit, void 0).pipe(
                  Effect.andThen(Effect.never),
                ),
              }),
            ),
          ),
        );

        const runFiber = yield* DesktopBackendManager.runBackendProcess({
          ...baseConfig,
          desktopTelemetryStream: Stream.empty,
          onExitObserved: () =>
            Effect.sync(() => {
              observedExits += 1;
            }),
        }).pipe(
          Effect.provide(Layer.merge(spawnerLayer, healthyHttpClientLayer)),
          Effect.forkChild,
        );

        yield* Deferred.await(observingExit);
        yield* Fiber.interrupt(runFiber);
        assert.equal(observedExits, 0);
      }),
    ),
  );

  it.effect("bounds output draining after an observed exit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const exitObserved = yield* Deferred.make<void>();
        const outputStarted = yield* Deferred.make<void>();
        const outputStopped = yield* Deferred.make<void>();
        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.succeed(
              makeProcess({
                stderr: Stream.fromEffect(
                  Deferred.succeed(outputStarted, void 0).pipe(
                    Effect.andThen(Effect.never),
                    Effect.ensuring(Deferred.succeed(outputStopped, void 0)),
                  ),
                ),
                exitCode: Deferred.await(outputStarted).pipe(
                  Effect.as(ChildProcessSpawner.ExitCode(1)),
                ),
              }),
            ),
          ),
        );

        const runFiber = yield* DesktopBackendManager.runBackendProcess({
          ...baseConfig,
          desktopTelemetryStream: Stream.empty,
          outputDrainTimeout: Duration.seconds(1),
          onExitObserved: () => Deferred.succeed(exitObserved, void 0).pipe(Effect.asVoid),
        }).pipe(
          Effect.provide(Layer.merge(spawnerLayer, healthyHttpClientLayer)),
          Effect.forkChild,
        );

        yield* Deferred.await(exitObserved);
        yield* TestClock.adjust(Duration.seconds(1));
        assert.equal((yield* Fiber.join(runFiber)).code.pipe(Option.getOrUndefined), 1);
        assert.isTrue(yield* Deferred.isDone(outputStopped));
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("continues routing desktop telemetry control messages after an invalid line", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const handled = yield* Deferred.make<boolean>();
        const controlMessage = encodeDesktopTelemetryControl({
          version: 1,
          type: "setDiagnosticsDemand",
          enabled: true,
        });
        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.succeed(
              makeProcess({
                getOutputFd: (fd) =>
                  fd === 5
                    ? Stream.encodeText(Stream.make(`not-json\n${controlMessage}\n`))
                    : Stream.empty,
                exitCode: Deferred.await(handled).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
              }),
            ),
          ),
        );
        const instance = yield* makeTestInstance({
          spawnerLayer,
          desktopTelemetryPublisher: {
            handleControlForSource: (_sourceId, message) =>
              message.type === "setDiagnosticsDemand"
                ? Deferred.succeed(handled, message.enabled).pipe(Effect.asVoid)
                : Effect.void,
          },
        });

        yield* instance.start;
        assert.isTrue(yield* Deferred.await(handled));
      }),
    ),
  );

  it.effect("drains trailing child output before persisting an unexpected exit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const persistedOutput = yield* Deferred.make<ReadonlyArray<string>>();
        const outputDrainStarted = yield* Deferred.make<void>();
        const outputChunks = yield* Ref.make<Array<string>>([]);
        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.succeed(
              makeProcess({
                stdout: Stream.fromEffect(
                  Deferred.succeed(outputDrainStarted, void 0).pipe(
                    Effect.andThen(Effect.sleep(Duration.seconds(1))),
                    Effect.as(new TextEncoder().encode("trailing output\n")),
                  ),
                ),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
              }),
            ),
          ),
        );
        const instance = yield* makeTestInstance({
          spawnerLayer,
          httpClientLayer: httpClientLayer(() => Effect.never),
          backendOutputLog: {
            writeOutputChunk: (_streamName, chunk) =>
              Ref.update(outputChunks, (current) => [...current, new TextDecoder().decode(chunk)]),
            persistFailure: () =>
              Ref.get(outputChunks).pipe(
                Effect.flatMap((chunks) => Deferred.succeed(persistedOutput, chunks)),
                Effect.asVoid,
              ),
          },
        });

        yield* instance.start;
        yield* Deferred.await(outputDrainStarted);
        yield* TestClock.adjust(Duration.seconds(1));

        assert.deepEqual(yield* Deferred.await(persistedOutput), ["trailing output\n"]);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("retries HTTP readiness before reporting the backend ready", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const requestUrls: Array<string> = [];
        const prunedRuntimes: Array<[string | null, string]> = [];
        const statuses = [503, 200];
        let readyCount = 0;
        const firstRequest = yield* Deferred.make<void>();
        const backendReady = yield* Deferred.make<void>();
        const processExit = yield* Deferred.make<void>();
        const pruneComplete = yield* Deferred.make<void>();
        const exited = yield* Queue.unbounded<void>();

        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.succeed(
              makeProcess({
                exitCode: Deferred.await(processExit).pipe(
                  Effect.as(ChildProcessSpawner.ExitCode(0)),
                ),
              }),
            ),
          ),
        );

        const instance = yield* makeTestInstance({
          spawnerLayer,
          config: {
            ...baseConfig,
            runningDistro: "Ubuntu",
            wslRuntimeId: "1.2.3-x64",
          },
          pruneRuntimes: (distro, runtimeId) =>
            Effect.sync(() => {
              prunedRuntimes.push([distro, runtimeId]);
            }).pipe(Effect.andThen(Deferred.succeed(pruneComplete, void 0)), Effect.asVoid),
          httpClientLayer: httpClientLayer((request) =>
            Effect.gen(function* () {
              const status = statuses.shift();
              assert.isDefined(status);
              requestUrls.push(request.url);
              yield* Deferred.succeed(firstRequest, void 0);
              return responseForRequest(request, status);
            }),
          ),
          onReady: Effect.sync(() => {
            readyCount += 1;
          }).pipe(Effect.andThen(Deferred.succeed(backendReady, void 0)), Effect.asVoid),
          backendOutputLog: {
            persistFailure: () => Queue.offer(exited, void 0).pipe(Effect.asVoid),
          },
        });

        yield* instance.start;
        yield* Deferred.await(firstRequest);

        assert.equal(readyCount, 0);
        assert.deepEqual(prunedRuntimes, []);
        assert.deepEqual(requestUrls, ["http://127.0.0.1:3773/.well-known/t3/environment"]);

        yield* TestClock.adjust(Duration.millis(100));
        yield* Deferred.await(backendReady);
        yield* Deferred.await(pruneComplete);
        yield* Deferred.succeed(processExit, void 0);
        yield* Queue.take(exited);

        assert.equal(readyCount, 1);
        assert.deepEqual(prunedRuntimes, [["Ubuntu", "1.2.3-x64"]]);
        assert.deepEqual(requestUrls, [
          "http://127.0.0.1:3773/.well-known/t3/environment",
          "http://127.0.0.1:3773/.well-known/t3/environment",
        ]);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect(
    "re-probes readiness after the first budget expires while the backend is still alive",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const requestUrls: Array<string> = [];
          let requestCount = 0;
          let readyCount = 0;
          let readinessTimeoutCount = 0;
          const firstProbe = yield* Deferred.make<void>();
          const childExit = yield* Deferred.make<void>();

          const spawnerLayer = Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() =>
              Effect.succeed(
                makeProcess({
                  exitCode: Deferred.await(childExit).pipe(
                    Effect.as(ChildProcessSpawner.ExitCode(0)),
                  ),
                }),
              ),
            ),
          );

          // The backend stays 503 through the first *two* readiness budgets
          // and only becomes healthy (200) for the third round, i.e. it comes
          // up well after the initial 50ms budget has expired.
          const httpLayer = httpClientLayer((request) =>
            Effect.gen(function* () {
              requestCount += 1;
              requestUrls.push(request.url);
              yield* Deferred.succeed(firstProbe, void 0);
              return responseForRequest(request, requestCount <= 2 ? 503 : 200);
            }),
          );

          const runFiber = yield* DesktopBackendManager.runBackendProcess({
            ...baseConfig,
            desktopTelemetryStream: Stream.empty,
            readinessTimeout: Duration.millis(50),
            onReady: () =>
              Effect.sync(() => {
                readyCount += 1;
              }),
            onReadinessFailure: () =>
              Effect.sync(() => {
                readinessTimeoutCount += 1;
              }),
          }).pipe(Effect.provide(Layer.merge(spawnerLayer, httpLayer)), Effect.forkChild);

          yield* Deferred.await(firstProbe);
          assert.equal(readyCount, 0);
          assert.equal(readinessTimeoutCount, 0);

          // The first 50ms readiness budget expires while the backend still
          // answers 503. The child is alive and may yet become healthy, so the
          // probe must start a fresh round instead of stopping permanently —
          // the pre-fix behavior left the app stuck on "Connecting to WSL…"
          // forever even though the backend kept running.
          yield* TestClock.adjust(Duration.millis(50));
          assert.equal(readinessTimeoutCount, 1);
          assert.equal(readyCount, 0);

          // The second budget also expires (backend still 503), then the third
          // round connects. The point is the probe persisted across budgets
          // while the process was alive instead of giving up after the first.
          yield* TestClock.adjust(Duration.millis(100));
          assert.equal(readinessTimeoutCount, 2);
          assert.equal(readyCount, 1);
          assert.equal(requestUrls.length, 3);

          yield* Deferred.succeed(childExit, void 0);
          assert.equal((yield* Fiber.join(runFiber)).code.pipe(Option.getOrUndefined), 0);
        }).pipe(Effect.provide(TestClock.layer())),
      ),
  );

  it.effect("starts the configured backend and closes the scoped process on stop", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let startCount = 0;
        let closedCount = 0;
        const closed = yield* Deferred.make<void>();
        const teardownStarted = yield* Deferred.make<void>();
        const finishTeardown = yield* Deferred.make<void>();
        const startedPids = yield* Queue.unbounded<number>();
        const ready = yield* Deferred.make<void>();
        const backendReadyFlag = yield* Ref.make(false);
        let shutdownCount = 0;
        let persistedFailureCount = 0;
        let discardedSessionCount = 0;
        let removedTelemetrySources = 0;

        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.gen(function* () {
              const scope = yield* Scope.Scope;
              startCount += 1;
              yield* Queue.offer(startedPids, 123);
              const close = Deferred.succeed(teardownStarted, undefined).pipe(
                Effect.andThen(Deferred.await(finishTeardown)),
                Effect.andThen(
                  Effect.sync(() => {
                    closedCount += 1;
                  }),
                ),
                Effect.andThen(Deferred.succeed(closed, void 0)),
                Effect.asVoid,
              );

              yield* Scope.addFinalizer(scope, close);

              return makeProcess({
                exitCode: Deferred.await(closed).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
                kill: () => close,
              });
            }),
          ),
        );

        const instance = yield* makeTestInstance({
          spawnerLayer,
          onReady: Ref.set(backendReadyFlag, true).pipe(
            Effect.andThen(Deferred.succeed(ready, void 0)),
            Effect.asVoid,
          ),
          onShutdown: Ref.set(backendReadyFlag, false).pipe(
            Effect.andThen(
              Effect.sync(() => {
                shutdownCount += 1;
              }),
            ),
          ),
          backendOutputLog: {
            persistFailure: () =>
              Effect.sync(() => {
                persistedFailureCount += 1;
              }),
            discardSession: Effect.sync(() => {
              discardedSessionCount += 1;
            }),
          },
          desktopTelemetryPublisher: {
            removeControlSource: () =>
              Effect.sync(() => {
                removedTelemetrySources += 1;
              }),
          },
        });
        assert.isTrue(Option.isNone(yield* instance.currentConfig));

        yield* instance.start;
        assert.equal(yield* Queue.take(startedPids), 123);
        yield* Deferred.await(ready);
        assert.isTrue(yield* Ref.get(backendReadyFlag));
        assert.deepEqual(yield* instance.currentConfig, Option.some(baseConfig));

        const runningSnapshot = yield* instance.snapshot;
        assert.equal(runningSnapshot.ready, true);
        assert.deepEqual(runningSnapshot.activePid, Option.some(123));

        const stopFiber = yield* instance.stop().pipe(Effect.forkChild);
        yield* Deferred.await(teardownStarted).pipe(Effect.timeout("1 second"));
        assert.isFalse(yield* Ref.get(backendReadyFlag));
        assert.equal(shutdownCount, 1);
        yield* Deferred.succeed(finishTeardown, undefined);
        yield* Fiber.join(stopFiber).pipe(Effect.timeout("1 second"));
        assert.equal(startCount, 1);
        assert.equal(closedCount, 1);
        assert.equal(persistedFailureCount, 0);
        assert.equal(discardedSessionCount, 1);
        assert.equal(removedTelemetrySources, 1);

        const stoppedSnapshot = yield* instance.snapshot;
        assert.isFalse(yield* Ref.get(backendReadyFlag));
        assert.equal(shutdownCount, 1);
        assert.equal(stoppedSnapshot.desiredRunning, false);
        assert.equal(stoppedSnapshot.ready, false);
        assert.equal(Option.isNone(stoppedSnapshot.activePid), true);
      }),
    ),
  );

  for (const { exitCode, persistsFailure } of [
    { exitCode: 0, persistsFailure: false },
    { exitCode: 1, persistsFailure: true },
  ]) {
    it.effect(
      `${persistsFailure ? "retains" : "discards"} drained shutdown output after a requested stop exits ${exitCode}`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const teardownStarted = yield* Deferred.make<void>();
            const allowExit = yield* Deferred.make<void>();
            const processExited = yield* Deferred.make<void>();
            const outputDrainStarted = yield* Deferred.make<void>();
            const allowOutput = yield* Deferred.make<void>();
            const outputChunks: Array<string> = [];
            const persisted: Array<{ readonly details: string; readonly chunks: Array<string> }> =
              [];
            let startCount = 0;
            let discardedSessionCount = 0;
            const spawnerLayer = Layer.succeed(
              ChildProcessSpawner.ChildProcessSpawner,
              ChildProcessSpawner.make(() =>
                Effect.gen(function* () {
                  startCount += 1;
                  const scope = yield* Scope.Scope;
                  yield* Scope.addFinalizer(
                    scope,
                    Deferred.succeed(teardownStarted, void 0).pipe(
                      Effect.andThen(Deferred.await(allowExit)),
                      Effect.andThen(Deferred.succeed(processExited, void 0)),
                      Effect.asVoid,
                    ),
                  );
                  return makeProcess({
                    exitCode: Deferred.await(processExited).pipe(
                      Effect.as(ChildProcessSpawner.ExitCode(exitCode)),
                    ),
                    stderr: Stream.fromEffect(
                      Deferred.succeed(outputDrainStarted, void 0).pipe(
                        Effect.andThen(Deferred.await(processExited)),
                        Effect.andThen(Deferred.await(allowOutput)),
                        Effect.as(new TextEncoder().encode("final shutdown diagnostic\n")),
                      ),
                    ),
                  });
                }),
              ),
            );
            const instance = yield* makeTestInstance({
              spawnerLayer,
              httpClientLayer: httpClientLayer(() => Effect.never),
              backendOutputLog: {
                writeOutputChunk: (_streamName, chunk) =>
                  Effect.sync(() => {
                    outputChunks.push(new TextDecoder().decode(chunk));
                  }),
                persistFailure: ({ details }) =>
                  Effect.sync(() => {
                    persisted.push({ details, chunks: [...outputChunks] });
                  }),
                discardSession: Effect.sync(() => {
                  discardedSessionCount += 1;
                }),
              },
            });

            yield* instance.start;
            yield* Deferred.await(outputDrainStarted);
            const stopFiber = yield* instance.stop().pipe(Effect.forkChild);
            yield* Deferred.await(teardownStarted);
            yield* Deferred.succeed(allowExit, void 0);
            yield* Deferred.await(processExited);
            assert.isUndefined(stopFiber.pollUnsafe());
            assert.deepEqual(persisted, []);
            assert.equal(discardedSessionCount, 0);

            yield* Deferred.succeed(allowOutput, void 0);
            yield* Fiber.join(stopFiber);
            assert.deepEqual(outputChunks, ["final shutdown diagnostic\n"]);
            assert.deepEqual(
              persisted,
              persistsFailure
                ? [{ details: `pid=123 code=${exitCode}`, chunks: outputChunks }]
                : [],
            );
            assert.equal(discardedSessionCount, persistsFailure ? 0 : 1);
            const snapshot = yield* instance.snapshot;
            assert.isFalse(snapshot.desiredRunning);
            assert.isFalse(snapshot.restartScheduled);
            assert.isTrue(Option.isNone(snapshot.activePid));
            yield* TestClock.adjust(Duration.seconds(10));
            assert.equal(startCount, 1);
          }).pipe(Effect.provide(TestClock.layer())),
        ),
    );
  }

  it.effect("restarts when start is requested during stop teardown", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const starts = yield* Queue.unbounded<number>();
        const teardownStarted = yield* Deferred.make<void>();
        const finishTeardown = yield* Deferred.make<void>();
        let startCount = 0;

        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.gen(function* () {
              const scope = yield* Scope.Scope;
              const closed = yield* Deferred.make<void>();
              startCount += 1;
              yield* Queue.offer(starts, startCount);
              if (startCount === 1) {
                yield* Scope.addFinalizer(
                  scope,
                  Deferred.succeed(teardownStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(finishTeardown)),
                    Effect.andThen(Deferred.succeed(closed, undefined)),
                    Effect.asVoid,
                  ),
                );
              } else {
                yield* Scope.addFinalizer(
                  scope,
                  Deferred.succeed(closed, undefined).pipe(Effect.asVoid),
                );
              }
              return makeProcess({
                exitCode: Deferred.await(closed).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
              });
            }),
          ),
        );

        const instance = yield* makeTestInstance({
          spawnerLayer,
          httpClientLayer: httpClientLayer(() => Effect.never),
        });

        yield* instance.start;
        assert.equal(yield* Queue.take(starts), 1);

        const stopFiber = yield* instance.stop().pipe(Effect.forkChild);
        yield* Deferred.await(teardownStarted).pipe(Effect.timeout("1 second"));
        yield* instance.start;
        assert.equal((yield* instance.snapshot).desiredRunning, true);

        yield* Deferred.succeed(finishTeardown, undefined);
        yield* Fiber.join(stopFiber).pipe(Effect.timeout("1 second"));
        yield* TestClock.adjust(Duration.millis(500));

        assert.equal(yield* Queue.take(starts).pipe(Effect.timeout("1 second")), 2);
        const restarted = yield* instance.snapshot;
        assert.equal(restarted.desiredRunning, true);
        assert.deepEqual(restarted.activePid, Option.some(123));
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("retries config resolution after a start request during stop teardown", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const starts = yield* Queue.unbounded<number>();
        const teardownStarted = yield* Deferred.make<void>();
        const finishTeardown = yield* Deferred.make<void>();
        const configAttempts = yield* Ref.make(0);
        let startCount = 0;

        const configFailure = PlatformError.systemError({
          _tag: "Unknown",
          module: "DesktopBackendManager",
          method: "configResolve",
          description: "transient configuration failure",
        });
        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.gen(function* () {
              const scope = yield* Scope.Scope;
              const closed = yield* Deferred.make<void>();
              startCount += 1;
              yield* Queue.offer(starts, startCount);
              if (startCount === 1) {
                yield* Scope.addFinalizer(
                  scope,
                  Deferred.succeed(teardownStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(finishTeardown)),
                    Effect.andThen(Deferred.succeed(closed, undefined)),
                    Effect.asVoid,
                  ),
                );
              } else {
                yield* Scope.addFinalizer(
                  scope,
                  Deferred.succeed(closed, undefined).pipe(Effect.asVoid),
                );
              }
              return makeProcess({
                exitCode: Deferred.await(closed).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
              });
            }),
          ),
        );
        const configResolve = Ref.updateAndGet(configAttempts, (attempt) => attempt + 1).pipe(
          Effect.flatMap((attempt) =>
            attempt === 2 ? Effect.fail(configFailure) : Effect.succeed(baseConfig),
          ),
        );
        const instance = yield* makeTestInstance({
          spawnerLayer,
          configResolve,
          httpClientLayer: httpClientLayer(() => Effect.never),
        });

        yield* instance.start;
        assert.equal(yield* Queue.take(starts), 1);

        const stopFiber = yield* instance.stop().pipe(Effect.forkChild);
        yield* Deferred.await(teardownStarted).pipe(Effect.timeout("1 second"));
        yield* instance.start;
        yield* Deferred.succeed(finishTeardown, undefined);
        yield* Fiber.join(stopFiber).pipe(Effect.timeout("1 second"));

        const pendingRestart = yield* instance.snapshot;
        assert.equal(pendingRestart.desiredRunning, true);
        assert.equal(pendingRestart.restartScheduled, true);

        yield* TestClock.adjust(Duration.seconds(2));

        assert.equal(yield* Queue.take(starts).pipe(Effect.timeout("1 second")), 2);
        assert.equal(yield* Ref.get(configAttempts), 3);
        assert.equal((yield* instance.snapshot).desiredRunning, true);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("keeps a timed-out run active until its process exits", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const starts = yield* Queue.unbounded<number>();
        const teardownStarted = yield* Deferred.make<void>();
        const finishTeardown = yield* Deferred.make<void>();
        let startCount = 0;

        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.gen(function* () {
              const scope = yield* Scope.Scope;
              const closed = yield* Deferred.make<void>();
              startCount += 1;
              yield* Queue.offer(starts, startCount);
              if (startCount === 1) {
                yield* Scope.addFinalizer(
                  scope,
                  Deferred.succeed(teardownStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(finishTeardown)),
                    Effect.andThen(Deferred.succeed(closed, undefined)),
                    Effect.asVoid,
                  ),
                );
              } else {
                yield* Scope.addFinalizer(
                  scope,
                  Deferred.succeed(closed, undefined).pipe(Effect.asVoid),
                );
              }
              return makeProcess({
                exitCode: Deferred.await(closed).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
              });
            }),
          ),
        );

        const instance = yield* makeTestInstance({
          spawnerLayer,
          httpClientLayer: httpClientLayer(() => Effect.never),
        });

        yield* instance.start;
        assert.equal(yield* Queue.take(starts), 1);

        const stopFiber = yield* instance
          .stop({ timeout: Duration.millis(100) })
          .pipe(Effect.forkChild);
        yield* Deferred.await(teardownStarted).pipe(Effect.timeout("1 second"));
        yield* instance.start;
        yield* TestClock.adjust(Duration.millis(100));
        yield* Fiber.join(stopFiber).pipe(Effect.timeout("1 second"));

        assert.equal(startCount, 1);
        const timedOut = yield* instance.snapshot;
        assert.equal(timedOut.desiredRunning, true);
        assert.deepEqual(timedOut.activePid, Option.some(123));

        yield* Deferred.succeed(finishTeardown, undefined);
        yield* TestClock.adjust(Duration.millis(500));

        assert.equal(yield* Queue.take(starts).pipe(Effect.timeout("1 second")), 2);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("does not notify shutdown before the first start has prior state", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let shutdownCount = 0;
        const closed = yield* Deferred.make<void>();
        const startedPids = yield* Queue.unbounded<number>();

        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.gen(function* () {
              yield* Queue.offer(startedPids, 123);
              const close = Deferred.succeed(closed, void 0).pipe(Effect.asVoid);
              return makeProcess({
                exitCode: Deferred.await(closed).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
                kill: () => close,
              });
            }),
          ),
        );

        const instance = yield* makeTestInstance({
          spawnerLayer,
          httpClientLayer: httpClientLayer(() => Effect.never),
          onShutdown: Effect.sync(() => {
            shutdownCount += 1;
          }),
        });

        yield* instance.start;
        assert.equal(yield* Queue.take(startedPids), 123);
        assert.equal(shutdownCount, 0);
      }),
    ),
  );

  it.effect("restarts an unexpectedly exited backend with the Effect clock", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const starts = yield* Queue.unbounded<number>();
        const failures = yield* Queue.unbounded<string>();
        let startCount = 0;

        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.sync(() => {
              startCount += 1;
              return makeProcess({
                exitCode: Queue.offer(starts, startCount).pipe(
                  Effect.as(ChildProcessSpawner.ExitCode(1)),
                ),
              });
            }),
          ),
        );

        const instance = yield* makeTestInstance({
          spawnerLayer,
          httpClientLayer: httpClientLayer(() => Effect.never),
          backendOutputLog: {
            persistFailure: ({ details }) => Queue.offer(failures, details).pipe(Effect.asVoid),
          },
        });

        yield* instance.start;

        assert.equal(yield* Queue.take(starts), 1);
        assert.equal(yield* Queue.take(failures), "pid=123 code=1");

        yield* TestClock.adjust(Duration.millis(499));
        assert.equal(yield* Queue.size(starts), 0);
        yield* TestClock.adjust(Duration.millis(1));
        assert.equal(yield* Queue.take(starts), 2);

        yield* TestClock.adjust(Duration.millis(999));
        assert.equal(yield* Queue.size(starts), 0);
        yield* TestClock.adjust(Duration.millis(1));
        assert.equal(yield* Queue.take(starts), 3);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("does not notify shutdown when a scheduled restart starts from non-ready state", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let shutdownCount = 0;

        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die("unexpected backend spawn")),
        );

        const instance = yield* makeTestInstance({
          spawnerLayer,
          config: {
            ...baseConfig,
            preflightFailure: Option.some({ reason: "preflight failed", fatal: false }),
          },
          onShutdown: Effect.sync(() => {
            shutdownCount += 1;
          }),
        });

        yield* instance.start;
        assert.equal(shutdownCount, 0);

        yield* TestClock.adjust(Duration.millis(500));
        assert.equal(shutdownCount, 0);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("surfaces a fatal preflight failure once and stops looping after the cap", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const failures: string[] = [];
        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die("unexpected backend spawn")),
        );

        const instance = yield* makeTestInstance({
          spawnerLayer,
          config: {
            ...baseConfig,
            preflightFailure: Option.some({ reason: "Node.js not found", fatal: true }),
          },
          onPreflightFailed: (failure) =>
            Effect.sync(() => {
              failures.push(failure.reason);
            }).pipe(Effect.as(false)),
        });

        yield* instance.start;
        assert.deepEqual(failures, []);

        // Five fatal attempts with exponential backoff (500ms, 1s, 2s, 4s) reach
        // the cap, at which point the failure is surfaced exactly once.
        yield* TestClock.adjust(Duration.millis(500));
        yield* TestClock.adjust(Duration.seconds(1));
        yield* TestClock.adjust(Duration.seconds(2));
        yield* TestClock.adjust(Duration.seconds(4));
        assert.deepEqual(failures, ["Node.js not found"]);

        // Past the cap the loop stops and nothing else is surfaced.
        yield* TestClock.adjust(Duration.seconds(8));
        yield* TestClock.adjust(Duration.seconds(30));
        assert.deepEqual(failures, ["Node.js not found"]);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("can be started again after a fatal preflight cap once config recovers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const failing = yield* Ref.make(true);
        const starts = yield* Queue.unbounded<number>();
        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Queue.offer(starts, 123).pipe(
              Effect.as(
                makeProcess({
                  exitCode: Effect.never,
                }),
              ),
            ),
          ),
        );

        const instance = yield* makeTestInstance({
          spawnerLayer,
          configResolve: Ref.get(failing).pipe(
            Effect.map((isFailing) =>
              isFailing
                ? {
                    ...baseConfig,
                    preflightFailure: Option.some({
                      reason: "Node.js not found",
                      fatal: true,
                    }),
                  }
                : baseConfig,
            ),
          ),
        });

        yield* instance.start;
        yield* TestClock.adjust(Duration.millis(500));
        yield* TestClock.adjust(Duration.seconds(1));
        yield* TestClock.adjust(Duration.seconds(2));
        yield* TestClock.adjust(Duration.seconds(4));
        yield* TestClock.adjust(Duration.seconds(8));

        const parked = yield* instance.snapshot;
        assert.equal(parked.desiredRunning, false);
        assert.equal(parked.ready, false);
        assert.isTrue(Option.isNone(parked.activePid));
        assert.equal(parked.restartScheduled, false);
        assert.equal(yield* Queue.size(starts), 0);

        yield* Ref.set(failing, false);
        yield* instance.start;

        assert.equal(yield* Queue.take(starts), 123);
        const running = yield* instance.snapshot;
        assert.equal(running.desiredRunning, true);
        assert.deepEqual(running.activePid, Option.some(123));
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("keeps retrying a transient (non-fatal) preflight failure without surfacing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const failures: string[] = [];
        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die("unexpected backend spawn")),
        );

        const instance = yield* makeTestInstance({
          spawnerLayer,
          config: {
            ...baseConfig,
            preflightFailure: Option.some({ reason: "wslpath conversion failed", fatal: false }),
          },
          onPreflightFailed: (failure) =>
            Effect.sync(() => {
              failures.push(failure.reason);
            }).pipe(Effect.as(false)),
        });

        yield* instance.start;
        // Well beyond the fatal cap's worth of time: a transient failure must
        // keep retrying (self-heal) and never surface.
        yield* TestClock.adjust(Duration.minutes(2));
        assert.deepEqual(failures, []);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("surfaces a bounded transient preflight failure after its retry limit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const failures: string[] = [];
        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die("unexpected backend spawn")),
        );

        const instance = yield* makeTestInstance({
          spawnerLayer,
          config: {
            ...baseConfig,
            preflightFailure: Option.some({
              reason: "WSL toolchain probe timed out",
              fatal: false,
              retryLimit: 3,
            }),
          },
          onPreflightFailed: (failure) =>
            Effect.sync(() => {
              failures.push(failure.reason);
            }).pipe(Effect.as(false)),
        });

        yield* instance.start;
        yield* TestClock.adjust(Duration.millis(500));
        assert.deepEqual(failures, []);

        yield* TestClock.adjust(Duration.seconds(1));
        assert.deepEqual(failures, ["WSL toolchain probe timed out"]);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("cancels a scheduled restart when start is requested manually", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const starts = yield* Queue.unbounded<number>();
        const secondClosed = yield* Deferred.make<void>();
        let startCount = 0;

        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.gen(function* () {
              startCount += 1;
              yield* Queue.offer(starts, startCount);

              if (startCount === 1) {
                return makeProcess({
                  exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
                });
              }

              const scope = yield* Scope.Scope;
              const close = Deferred.succeed(secondClosed, void 0).pipe(Effect.asVoid);
              yield* Scope.addFinalizer(scope, close);
              return makeProcess({
                exitCode: Deferred.await(secondClosed).pipe(
                  Effect.as(ChildProcessSpawner.ExitCode(0)),
                ),
                kill: () => close,
              });
            }),
          ),
        );

        const instance = yield* makeTestInstance({
          spawnerLayer,
          httpClientLayer: httpClientLayer(() => Effect.never),
        });

        yield* instance.start;

        assert.equal(yield* Queue.take(starts), 1);
        let restartScheduled = false;
        while (!restartScheduled) {
          restartScheduled = (yield* instance.snapshot).restartScheduled;
          if (!restartScheduled) {
            yield* Effect.yieldNow;
          }
        }

        yield* instance.start;
        assert.equal(yield* Queue.take(starts), 2);

        yield* instance.stop();
        yield* TestClock.adjust(Duration.millis(500));

        assert.equal(yield* Queue.size(starts), 0);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("does not restart after stop cancels a scheduled restart", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const starts = yield* Queue.unbounded<number>();
        let startCount = 0;

        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.sync(() => {
              startCount += 1;
              return makeProcess({
                exitCode: Queue.offer(starts, startCount).pipe(
                  Effect.as(ChildProcessSpawner.ExitCode(1)),
                ),
              });
            }),
          ),
        );

        const instance = yield* makeTestInstance({
          spawnerLayer,
          httpClientLayer: httpClientLayer(() => Effect.never),
        });

        yield* instance.start;
        assert.equal(yield* Queue.take(starts), 1);

        let restartScheduled = false;
        while (!restartScheduled) {
          restartScheduled = (yield* instance.snapshot).restartScheduled;
          if (!restartScheduled) {
            yield* Effect.yieldNow;
          }
        }

        yield* instance.stop();
        yield* TestClock.adjust(Duration.millis(500));

        assert.equal(yield* Queue.size(starts), 0);
        assert.equal((yield* instance.snapshot).desiredRunning, false);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("stopAllPoolInstances awaits concurrent backend cleanup before quitting", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // Each backend's process-scope finalizer reports when it starts and
        // when it finishes, keyed by instance name, so the test can prove
        // both backends reached each milestone instead of inferring it from
        // a shared flag or a clock advance.
        const teardownStarted = yield* Queue.unbounded<string>();
        const teardownFinished = yield* Queue.unbounded<string>();
        const allowTeardown = yield* Deferred.make<void>();

        const makeInstance = (name: string) =>
          makeTestInstance({
            spawnerLayer: Layer.succeed(
              ChildProcessSpawner.ChildProcessSpawner,
              ChildProcessSpawner.make(() =>
                Effect.gen(function* () {
                  const scope = yield* Scope.Scope;
                  yield* Scope.addFinalizer(
                    scope,
                    Queue.offer(teardownStarted, name).pipe(
                      Effect.andThen(Deferred.await(allowTeardown)),
                      Effect.andThen(Queue.offer(teardownFinished, name)),
                      Effect.asVoid,
                    ),
                  );
                  return makeProcess({
                    exitCode: Deferred.await(allowTeardown).pipe(
                      Effect.as(ChildProcessSpawner.ExitCode(0)),
                    ),
                  });
                }),
              ),
            ),
            httpClientLayer: httpClientLayer(() => Effect.never),
          });

        const instance1 = yield* makeInstance("instance1");
        const instance2 = yield* makeInstance("instance2");

        yield* instance1.start;
        yield* instance2.start;

        const mockPool = Layer.succeed(DesktopBackendPool.DesktopBackendPool, {
          list: Effect.succeed([instance1, instance2]),
          get: () => Effect.succeedNone,
          primary: Effect.die(new Error("primary not implemented")),
          register: () => Effect.die(new Error("register not implemented")),
          unregister: () => Effect.die(new Error("unregister not implemented")),
        });

        // Mirror the quit path: register stopAllPoolInstances as a scope
        // finalizer and let the scope close run it, rather than calling it
        // as an ordinary interruptible effect.
        const quitFiber = yield* Effect.scoped(
          Effect.addFinalizer(() => DesktopApp.stopAllPoolInstances()),
        ).pipe(Effect.provide(mockPool), Effect.forkChild);

        const started = yield* Queue.takeN(teardownStarted, 2);
        assert.deepEqual(started.toSorted(), ["instance1", "instance2"]);

        // The manager owns escalation. The application must not abandon
        // either stop when native cleanup takes longer than five seconds.
        yield* TestClock.adjust(Duration.seconds(5));
        assert.isUndefined(quitFiber.pollUnsafe());
        assert.equal(yield* Queue.size(teardownFinished), 0);

        yield* Deferred.succeed(allowTeardown, undefined);
        const finished = yield* Queue.takeN(teardownFinished, 2);
        assert.deepEqual(finished.toSorted(), ["instance1", "instance2"]);
        yield* Fiber.join(quitFiber);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );
});
