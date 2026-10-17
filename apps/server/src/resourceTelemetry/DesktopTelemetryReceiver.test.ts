// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import { assert, describe, expect } from "vite-plus/test";

import {
  type DesktopTelemetryReceiverHealth,
  initialDesktopTelemetryContactAt,
  isDesktopTelemetryContactStale,
  recordDesktopTelemetrySampleHealth,
  requireDesktopTelemetryWriteProgress,
  resolveDesktopTelemetrySnapshotStaleAfterMs,
  writeAllToFileDescriptor,
} from "./DesktopTelemetryReceiver.ts";

describe("DesktopTelemetryReceiver", () => {
  it("exits after receiver cleanup while the parent keeps the telemetry writer open", async () => {
    const directory = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3-desktop-telemetry-exit-test-"),
    );
    const child = NodeChildProcess.spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import * as Effect from ${JSON.stringify(import.meta.resolve("effect/Effect"))};
import * as Option from ${JSON.stringify(import.meta.resolve("effect/Option"))};
import * as Stream from ${JSON.stringify(import.meta.resolve("effect/Stream"))};
import * as NodeServices from ${JSON.stringify(import.meta.resolve("@effect/platform-node/NodeServices"))};
const ServerConfig = await import(${JSON.stringify(new URL("../config.ts", import.meta.url).href)});
const ServerSettings = await import(${JSON.stringify(new URL("../serverSettings.ts", import.meta.url).href)});
const { make } = await import(${JSON.stringify(new URL("./DesktopTelemetryReceiver.ts", import.meta.url).href)});
const stop = new Promise((resolve) => process.once("message", resolve));
await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const receiver = yield* make().pipe(Effect.provideService(ServerConfig.ServerConfig, {
    ...config, mode: "desktop", desktopTelemetryFd: 3,
  }));
  const subscription = yield* receiver.subscribeHealth;
  process.send("ready");
  yield* subscription.changes.pipe(
    Stream.filter((health) => health.status === "healthy"),
    Stream.runHead,
  );
  if (Option.isSome(yield* receiver.latest)) throw new Error("Hello became a resource sample");
  // Let the reader wait for the next frame before asking it to shut down.
  yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));
  process.send("healthy");
  yield* Effect.promise(() => stop);
})).pipe(
  Effect.provide(ServerSettings.layerTest()),
  Effect.provide(ServerConfig.layerTest(${JSON.stringify(directory)}, ${JSON.stringify(directory)})),
  Effect.provide(NodeServices.layer),
));
await new Promise((resolve, reject) => process.send("finalized", (error) => error ? reject(error) : resolve()));
process.exit(0);`,
      ],
      { stdio: ["ignore", "ignore", "pipe", "pipe", "ipc"] },
    );
    const telemetry = child.stdio[3];
    let stderr = "";
    child.stderr?.on("data", (data) => {
      stderr += String(data);
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      },
    );
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let stage = "starting";
    const timedOut = new Promise<never>((_, reject) => {
      // The deadline measures an actual child exit outside the Effect test clock.
      // @effect-diagnostics-next-line globalTimers:off
      deadline = setTimeout(
        () =>
          reject(new Error(`Telemetry child stalled at ${stage} with its writer open. ${stderr}`)),
        10_000,
      );
    });
    const nextMessage = () =>
      Promise.race([
        new Promise<unknown>((resolve) => child.once("message", resolve)),
        exited.then(({ code, signal }) => {
          throw new Error(`Telemetry child exited early (${code}, ${signal}). ${stderr}`);
        }),
        timedOut,
      ]);
    try {
      assert.ok(telemetry instanceof NodeNet.Socket);
      telemetry.allowHalfOpen = true;
      assert.equal(await nextMessage(), "ready");
      stage = "waiting for hello";
      const healthy = nextMessage();
      // NDJSON framing must survive both split writes and empty lines.
      telemetry.write('\n{"version":1,"type":"desktopTelemetry');
      telemetry.write('Hello","electronPid":1}\n');
      assert.equal(await healthy, "healthy");
      stage = "receiver cleanup";
      const finalized = nextMessage();
      child.send("stop");
      assert.equal(await finalized, "finalized");
      stage = "process exit after receiver cleanup";
      assert.equal(telemetry.writableEnded, false);
      assert.deepEqual(await Promise.race([exited, timedOut]), { code: 0, signal: null });
    } finally {
      clearTimeout(deadline);
      // Closing the writer is cleanup only, never what allows this test to pass.
      telemetry?.destroy();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited.catch(() => undefined);
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("degrades a hello-only stream after the first-sample deadline", () => {
    expect(isDesktopTelemetryContactStale(Option.some(1_000), 90_999)).toBe(false);
    expect(isDesktopTelemetryContactStale(Option.some(1_000), 91_000)).toBe(true);
    expect(isDesktopTelemetryContactStale(Option.none(), 1_000_000)).toBe(false);
  });

  it("starts the stale deadline as soon as a telemetry descriptor is opened", () => {
    expect(initialDesktopTelemetryContactAt(7, 1_000)).toEqual(Option.some(1_000));
    expect(initialDesktopTelemetryContactAt(undefined, 1_000)).toEqual(Option.none());
  });

  it("keeps the snapshot deadline beyond the configured idle polling interval", () => {
    expect(resolveDesktopTelemetrySnapshotStaleAfterMs(30_000, 120_000)).toBe(150_000);
    expect(resolveDesktopTelemetrySnapshotStaleAfterMs(60_000, 600_000)).toBe(630_000);
    expect(resolveDesktopTelemetrySnapshotStaleAfterMs(1_000, 1_000)).toBe(90_000);
  });

  it.effect("publishes the latest sample timestamp while health remains healthy", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const initialSample = DateTime.makeUnsafe(1_000);
        const nextSample = DateTime.makeUnsafe(2_000);
        const health = yield* Ref.make<DesktopTelemetryReceiverHealth>({
          status: "healthy",
          lastSampleAt: Option.some(initialSample),
          lastError: Option.none<string>(),
        });
        const healthChanges = yield* PubSub.sliding<DesktopTelemetryReceiverHealth>(4);
        const subscription = yield* PubSub.subscribe(healthChanges);

        yield* recordDesktopTelemetrySampleHealth(health, healthChanges, nextSample);
        const published = yield* PubSub.take(subscription).pipe(Effect.timeout("1 second"));

        expect(DateTime.toEpochMillis(Option.getOrThrow(published.lastSampleAt))).toBe(2_000);
      }),
    ),
  );

  it.effect("writes control messages through the asynchronous descriptor path", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const directory = NodeFS.mkdtempSync(
          NodePath.join(NodeOS.tmpdir(), "t3-desktop-telemetry-control-test-"),
        );
        const path = NodePath.join(directory, "control.ndjson");
        return {
          directory,
          path,
          fd: NodeFS.openSync(path, "w"),
        };
      }),
      ({ fd, path }) =>
        Effect.gen(function* () {
          const payload = Buffer.from('{"type":"setDiagnosticsDemand","enabled":true}\n');
          yield* writeAllToFileDescriptor(fd, payload);
          NodeFS.fsyncSync(fd);

          assert.equal(NodeFS.readFileSync(path, "utf8"), payload.toString("utf8"));
        }),
      ({ directory, fd }) =>
        Effect.sync(() => {
          NodeFS.closeSync(fd);
          NodeFS.rmSync(directory, { recursive: true, force: true });
        }),
    ),
  );

  it.effect("models a zero-byte control write as a stalled descriptor", () =>
    Effect.gen(function* () {
      const error = yield* requireDesktopTelemetryWriteProgress(7, 42, 0).pipe(Effect.flip);

      expect(error._tag).toBe("DesktopTelemetryControlStalled");
      expect(error.fd).toBe(7);
      expect(error.remainingBytes).toBe(42);
      expect(error.message).toBe(
        "Desktop telemetry control stalled on fd 7 with 42 bytes remaining.",
      );
      yield* requireDesktopTelemetryWriteProgress(7, 42, 1);
    }),
  );
});
