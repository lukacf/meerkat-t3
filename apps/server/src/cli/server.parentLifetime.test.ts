// @effect-diagnostics nodeBuiltinImport:off
import * as NodeStream from "node:stream";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NetService from "@t3tools/shared/Net";
import * as Deferred from "effect/Deferred";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { GlobalFlag } from "effect/unstable/cli";
import { beforeEach, vi } from "vite-plus/test";

import { runServerCommand } from "./server.ts";
import type { CliServerFlags } from "./config.ts";
import { DesktopParentLifetimeError } from "../desktopParentLifetime.ts";

const isDesktopParentLifetimeError = Schema.is(DesktopParentLifetimeError);

const fixture = vi.hoisted(() => ({
  fd: undefined as number | undefined,
  input: null as NodeStream.PassThrough | null,
  run: null as (() => Effect.Effect<void, string>) | null,
  opened: [] as number[],
  openError: null as Error | null,
}));

vi.mock("../server.ts", async () => {
  const Effect = await import("effect/Effect");
  return {
    runServer: Effect.suspend(() => {
      if (fixture.run === null) return Effect.die("Missing server lifetime fixture");
      return fixture.run();
    }),
  };
});

vi.mock("./config.ts", async () => {
  const Effect = await import("effect/Effect");
  return {
    sharedServerCommandFlags: {},
    resolveServerConfig: () =>
      Effect.succeed({ mode: "desktop", desktopParentLifetimeFd: fixture.fd }),
  };
});

vi.mock("node:net", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:net")>();
  return {
    ...actual,
    Socket: function (options: { fd: number; readable: boolean; writable: boolean }) {
      fixture.opened.push(options.fd);
      if (fixture.openError !== null) throw fixture.openError;
      if (options.fd !== fixture.fd || fixture.input === null) throw new Error("Unexpected pipe");
      return fixture.input;
    },
  };
});

const flags: CliServerFlags = {
  mode: Option.none(),
  port: Option.none(),
  host: Option.none(),
  baseDir: Option.none(),
  cwd: Option.none(),
  devUrl: Option.none(),
  noBrowser: Option.none(),
  bootstrapFd: Option.none(),
  autoBootstrapProjectFromCwd: Option.none(),
  logWebSocketEvents: Option.none(),
  tailscaleServeEnabled: Option.none(),
  tailscaleServePort: Option.none(),
};

const runCommand = runServerCommand(flags).pipe(
  Effect.provideService(GlobalFlag.LogLevel, Option.none()),
  Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer)),
);

beforeEach(() => {
  fixture.fd = 6;
  fixture.input = new NodeStream.PassThrough();
  fixture.run = null;
  fixture.opened = [];
  fixture.openError = null;
});

it.effect("parent lifetime EOF interrupts the server and awaits its cleanup receipt", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const cleanupStarted = yield* Deferred.make<void>();
      const cleanupAllowed = yield* Deferred.make<void>();
      const input = fixture.input!;
      fixture.run = () =>
        Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() =>
              Deferred.succeed(cleanupStarted, undefined).pipe(
                Effect.andThen(Deferred.await(cleanupAllowed)),
              ),
            );
            yield* Deferred.succeed(started, undefined);
            return yield* Effect.never;
          }),
        );
      const fiber = yield* runCommand.pipe(Effect.forkScoped);
      try {
        yield* Deferred.await(started);
        input.emit("end");
        yield* Deferred.await(cleanupStarted);
        assert.isUndefined(fiber.pollUnsafe());
        assert.deepEqual(fixture.opened, [6]);
        yield* Deferred.succeed(cleanupAllowed, undefined);
        yield* Fiber.join(fiber);
        assert.isTrue(input.closed);
      } finally {
        yield* Deferred.succeed(cleanupAllowed, undefined);
        input.destroy();
      }
    }),
  ),
);

it.effect("omitting parent lifetime preserves independent server operation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      fixture.fd = undefined;
      const started = yield* Deferred.make<void>();
      const input = fixture.input!;
      fixture.run = () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never));
      const fiber = yield* runCommand.pipe(Effect.forkScoped);
      try {
        yield* Deferred.await(started);
        input.emit("end");
        yield* Effect.yieldNow;
        assert.isUndefined(fiber.pollUnsafe());
        assert.deepEqual(fixture.opened, []);
      } finally {
        input.destroy();
      }
    }),
  ),
);

it.effect.each(["read-error", "premature-close"] as const)(
  "parent lifetime %s stops the server through its finalizer",
  (failure) =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const cleaned = yield* Deferred.make<void>();
        const input = fixture.input!;
        fixture.run = () =>
          Effect.scoped(
            Effect.gen(function* () {
              yield* Effect.addFinalizer(() => Deferred.succeed(cleaned, undefined));
              yield* Deferred.succeed(started, undefined);
              return yield* Effect.never;
            }),
          );
        const fiber = yield* runCommand.pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        if (failure === "read-error") input.emit("error", new Error("Pipe read failed"));
        else input.destroy();
        const exit = yield* Fiber.await(fiber);
        assert.isTrue(Exit.isFailure(exit));
        if (Exit.isFailure(exit)) {
          assert.isTrue(
            exit.cause.reasons.some(
              (reason) => Cause.isFailReason(reason) && isDesktopParentLifetimeError(reason.error),
            ),
          );
        }
        assert.isTrue(yield* Deferred.isDone(cleaned));
        assert.isTrue(input.closed);
      }),
    ),
);

it.effect(
  "parent loss during acquisition cleans partial resources before the server becomes ready",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const acquiring = yield* Deferred.make<void>();
        const finishAcquisition = yield* Deferred.make<void>();
        const input = fixture.input!;
        const events: string[] = [];
        fixture.run = () =>
          Effect.scoped(
            Effect.gen(function* () {
              yield* Effect.addFinalizer(() => Effect.sync(() => events.push("partial cleanup")));
              yield* Deferred.succeed(acquiring, undefined);
              yield* Deferred.await(finishAcquisition);
              events.push("ready");
              return yield* Effect.never;
            }),
          );
        const fiber = yield* runCommand.pipe(Effect.forkScoped);
        yield* Deferred.await(acquiring);
        input.emit("end");
        yield* Fiber.join(fiber);
        assert.deepEqual(events, ["partial cleanup"]);
        assert.isTrue(input.closed);
      }),
    ),
);

it.effect(
  "server-first failure closes the live ownership reader without waiting for parent EOF",
  () =>
    Effect.gen(function* () {
      const input = fixture.input!;
      fixture.run = () => Effect.fail("server acquisition failed");
      const exit = yield* Effect.exit(runCommand);
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit))
        assert.include(Cause.pretty(exit.cause), "server acquisition failed");
      assert.deepEqual(fixture.opened, [6]);
      assert.isTrue(input.closed);
      assert.equal(input.listenerCount("end"), 0);
      assert.equal(input.listenerCount("error"), 0);
    }),
);

it.effect("an unavailable declared ownership pipe prevents server acquisition", () =>
  Effect.gen(function* () {
    fixture.openError = new Error("Bad inherited descriptor");
    let started = false;
    fixture.run = () =>
      Effect.sync(() => {
        started = true;
      }).pipe(Effect.andThen(Effect.never));
    const exit = yield* Effect.exit(runCommand);
    assert.isTrue(Exit.isFailure(exit));
    assert.isFalse(started);
    fixture.input?.destroy();
  }),
);

it.effect("parent EOF does not hide a server cleanup failure", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      fixture.run = () =>
        Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() => Effect.die(new Error("Native cleanup failed")));
            yield* Deferred.succeed(started, undefined);
            return yield* Effect.never;
          }),
        );
      const fiber = yield* runCommand.pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      fixture.input!.emit("end");
      const exit = yield* Fiber.await(fiber);
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) assert.include(Cause.pretty(exit.cause), "Native cleanup failed");
    }),
  ),
);

it.effect.each(["external-interrupt", "EOF-then-external-interrupt"] as const)(
  "%s waits for server cleanup and preserves its failure",
  (interruption) =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const cleanupStarted = yield* Deferred.make<void>();
        const cleanupAllowed = yield* Deferred.make<void>();
        const input = fixture.input!;
        fixture.run = () =>
          Effect.scoped(
            Effect.gen(function* () {
              yield* Effect.addFinalizer(() =>
                Deferred.succeed(cleanupStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(cleanupAllowed)),
                  Effect.andThen(Effect.die(new Error("Interrupted native cleanup failed"))),
                ),
              );
              yield* Deferred.succeed(started, undefined);
              return yield* Effect.never;
            }),
          );
        const fiber = yield* runCommand.pipe(Effect.forkScoped);
        try {
          yield* Deferred.await(started);
          if (interruption === "EOF-then-external-interrupt") {
            input.emit("end");
            yield* Deferred.await(cleanupStarted);
          }
          const interrupting = yield* Fiber.interrupt(fiber).pipe(Effect.forkScoped);
          yield* Deferred.await(cleanupStarted);
          assert.isUndefined(interrupting.pollUnsafe());
          assert.isUndefined(fiber.pollUnsafe());
          yield* Deferred.succeed(cleanupAllowed, undefined);
          yield* Fiber.join(interrupting);
          const exit = yield* Fiber.await(fiber);
          assert.isTrue(Exit.isFailure(exit));
          if (Exit.isFailure(exit)) {
            assert.include(Cause.pretty(exit.cause), "Interrupted native cleanup failed");
          }
          assert.isTrue(input.closed);
        } finally {
          yield* Deferred.succeed(cleanupAllowed, undefined);
          input.destroy();
        }
      }),
    ),
);
