import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  OrchestrationDispatchCommandError,
  ThreadId,
  WorktreeSetupSnapshot,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as WorktreeSetupTracker from "./WorktreeSetupTracker.ts";

const threadId = ThreadId.make("thread-1");
const commandId = CommandId.make("bootstrap-1");
class BootstrapSequence extends Context.Service<BootstrapSequence, number>()(
  "t3/project/WorktreeSetupTracker.test/BootstrapSequence",
) {}

describe("WorktreeSetupTracker", () => {
  it.effect("joins the same active request using only the original operation and context", () =>
    Effect.gen(function* () {
      const tracker = yield* WorktreeSetupTracker.make;
      const entered = yield* Deferred.make<void>();
      const complete = yield* Deferred.make<void>();
      let starts = 0;
      const operation = Effect.gen(function* () {
        starts += 1;
        const sequence = yield* BootstrapSequence;
        yield* Deferred.succeed(entered, undefined);
        yield* Deferred.await(complete);
        return { sequence };
      });
      const first = yield* tracker
        .runBootstrapOnce({ threadId, commandId }, operation)
        .pipe(Effect.provideService(BootstrapSequence, 41), Effect.forkChild);
      yield* Deferred.await(entered);
      const joined = yield* tracker
        .runBootstrapOnce({ threadId, commandId }, operation)
        .pipe(Effect.provideService(BootstrapSequence, 99), Effect.forkChild);
      yield* Effect.yieldNow;
      expect(starts).toBe(1);
      yield* Deferred.succeed(complete, undefined);
      expect(yield* Fiber.join(first)).toEqual({ sequence: 41 });
      expect(yield* Fiber.join(joined)).toEqual({ sequence: 41 });
      expect(starts).toBe(1);
    }),
  );

  it.effect(
    "rejects a competing request without replacing active setup or blocking another thread",
    () =>
      Effect.gen(function* () {
        const tracker = yield* WorktreeSetupTracker.make;
        const entered = yield* Deferred.make<void>();
        const complete = yield* Deferred.make<void>();
        const first = yield* tracker
          .runBootstrapOnce(
            { threadId, commandId },
            Effect.gen(function* () {
              yield* tracker.begin({
                threadId,
                branch: "original",
                baseRef: "main",
                stages: ["checkout"],
                fiber: null,
              });
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(complete);
              return { sequence: 7 };
            }),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const before = yield* tracker.get(threadId);
        let competingStarts = 0;
        const competing = yield* tracker
          .runBootstrapOnce(
            { threadId, commandId: CommandId.make("competing") },
            Effect.sync(() => {
              competingStarts += 1;
              return { sequence: 8 };
            }),
          )
          .pipe(Effect.result);
        expect(competing._tag).toBe("Failure");
        if (competing._tag === "Failure") {
          expect(competing.failure.message).toContain("already preparing");
          expect(competing.failure.bootstrapThreadDisposition).toBeUndefined();
        }
        expect(competingStarts).toBe(0);
        expect(yield* tracker.get(threadId)).toEqual(before);
        expect(
          yield* tracker.runBootstrapOnce(
            { threadId: ThreadId.make("independent"), commandId: CommandId.make("independent") },
            Effect.succeed({ sequence: 9 }),
          ),
        ).toEqual({ sequence: 9 });
        yield* Deferred.succeed(complete, undefined);
        expect(yield* Fiber.join(first)).toEqual({ sequence: 7 });
      }),
  );

  it.effect(
    "keeps the original reservation and operation alive after its client waiter is interrupted",
    () =>
      Effect.gen(function* () {
        const tracker = yield* WorktreeSetupTracker.make;
        const entered = yield* Deferred.make<void>();
        const complete = yield* Deferred.make<void>();
        let starts = 0;
        let interrupted = false;
        const operation = Effect.gen(function* () {
          starts += 1;
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(complete);
          return { sequence: 15 };
        }).pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              interrupted = true;
            }),
          ),
        );
        const disconnected = yield* tracker
          .runBootstrapOnce({ threadId, commandId }, operation)
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(disconnected);
        expect(Exit.hasInterrupts(yield* Fiber.await(disconnected))).toBe(true);
        expect(interrupted).toBe(false);
        const reconnect = yield* tracker
          .runBootstrapOnce({ threadId, commandId }, operation)
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        expect(starts).toBe(1);
        yield* Deferred.succeed(complete, undefined);
        expect(yield* Fiber.join(reconnect)).toEqual({ sequence: 15 });
        expect(interrupted).toBe(false);
        expect(starts).toBe(1);
      }),
  );

  it.effect(
    "shares the original failure and releases its reservation only after the operation settles",
    () =>
      Effect.gen(function* () {
        const tracker = yield* WorktreeSetupTracker.make;
        const entered = yield* Deferred.make<void>();
        const complete = yield* Deferred.make<void>();
        const failure = new OrchestrationDispatchCommandError({ message: "Preparation failed" });
        let starts = 0;
        const operation = Effect.gen(function* () {
          starts += 1;
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(complete);
          return yield* failure;
        });
        const first = yield* tracker
          .runBootstrapOnce({ threadId, commandId }, operation)
          .pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(entered);
        const joined = yield* tracker
          .runBootstrapOnce({ threadId, commandId }, operation)
          .pipe(Effect.result, Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(complete, undefined);
        const original = yield* Fiber.join(first);
        const replayed = yield* Fiber.join(joined);
        expect(original).toEqual(replayed);
        expect(original._tag).toBe("Failure");
        if (original._tag === "Failure") expect(original.failure).toBe(failure);
        expect(starts).toBe(1);
        // A later explicit call runs its own durable-state check, not cached work.
        expect(
          yield* tracker.runBootstrapOnce(
            { threadId, commandId },
            Effect.sync(() => {
              starts += 1;
              return { sequence: 23 };
            }),
          ),
        ).toEqual({ sequence: 23 });
        expect(starts).toBe(2);
      }),
  );

  it.effect("records stage transitions, checkout progress, and the final phase", () =>
    Effect.gen(function* () {
      const tracker = yield* WorktreeSetupTracker.make;
      yield* tracker.begin({
        threadId,
        branch: "feature",
        baseRef: "main",
        stages: ["checkout", "fetch", "agent"],
        fiber: null,
      });

      const initial = yield* tracker.get(threadId);
      // Stages are reordered into the canonical setup order.
      expect(initial?.stages.map((stage) => stage.id)).toEqual(["fetch", "checkout", "agent"]);
      expect(initial?.phase).toBe("running");

      yield* tracker.stageStatus(threadId, "fetch", "running");
      yield* tracker.stageStatus(threadId, "fetch", "done", "origin/main at abc1234");
      yield* tracker.stageStatus(threadId, "checkout", "running");
      yield* tracker.stage(threadId, "checkout", { percent: 42, detail: "42 / 100 files" });
      yield* tracker.finish(threadId, "failed", "boom");

      const final = yield* tracker.get(threadId);
      expect(final?.phase).toBe("failed");
      expect(final?.error).toBe("boom");
      const [fetch, checkout, agent] = final?.stages ?? [];
      expect(fetch).toMatchObject({ status: "done", detail: "origin/main at abc1234" });
      expect(fetch?.startedAt).not.toBeNull();
      expect(fetch?.endedAt).not.toBeNull();
      // A stage still running when the setup fails is marked failed.
      expect(checkout).toMatchObject({ status: "failed", percent: 42 });
      expect(agent?.status).toBe("pending");
      expect(final?.sequence).toBeGreaterThan(initial?.sequence ?? 0);
    }),
  );

  it.effect("stream emits the current snapshot first and then only newer ones", () =>
    Effect.gen(function* () {
      const tracker = yield* WorktreeSetupTracker.make;
      yield* tracker.begin({
        threadId,
        branch: null,
        baseRef: null,
        stages: ["agent"],
        fiber: null,
      });

      const collected = yield* tracker.stream(threadId).pipe(
        Stream.takeUntil((snapshot) => snapshot?.sequence === 2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* tracker.stageStatus(threadId, "agent", "running");
      yield* tracker.appendTail(threadId, "agent", "line 1");

      const snapshots = yield* Fiber.join(collected);
      const sequences = snapshots.map((snapshot) => snapshot?.sequence ?? -1);
      expect(sequences.at(-1)).toBe(2);
      // Delivery is latest-value per subscriber, so intermediates may be
      // skipped but never delivered out of order.
      expect(sequences).toEqual([...sequences].toSorted((a, b) => a - b));
      expect(snapshots.at(-1)?.stages[0]?.tail).toEqual(["line 1"]);
    }),
  );

  it.effect("stream never steps back behind the snapshot it started from", () =>
    Effect.gen(function* () {
      const tracker = yield* WorktreeSetupTracker.make;
      yield* tracker.begin({
        threadId,
        branch: null,
        baseRef: null,
        stages: ["agent"],
        fiber: null,
      });
      yield* tracker.stageStatus(threadId, "agent", "running");
      yield* tracker.stageStatus(threadId, "agent", "done");

      // A late subscriber starts at sequence 2 and must never see 0 or 1.
      const collected = yield* tracker.stream(threadId).pipe(
        Stream.takeUntil((snapshot) => snapshot?.phase === "done"),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* tracker.finish(threadId, "done");

      const snapshots = yield* Fiber.join(collected);
      expect(snapshots.length).toBeGreaterThan(0);
      expect(snapshots.every((snapshot) => (snapshot?.sequence ?? -1) >= 2)).toBe(true);
      expect(snapshots.at(-1)?.phase).toBe("done");
    }),
  );

  it.effect("a new setup on the same thread keeps sequences increasing", () =>
    Effect.gen(function* () {
      const tracker = yield* WorktreeSetupTracker.make;
      yield* tracker.begin({
        threadId,
        branch: "first",
        baseRef: null,
        stages: ["agent"],
        fiber: null,
      });
      yield* tracker.finish(threadId, "failed", "boom");
      const failedSequence = (yield* tracker.get(threadId))?.sequence ?? -1;

      // A stream opened on the failed setup must still receive the next one.
      const collected = yield* tracker.stream(threadId).pipe(
        Stream.takeUntil((snapshot) => snapshot?.branch === "second"),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* tracker.begin({
        threadId,
        branch: "second",
        baseRef: null,
        stages: ["agent"],
        fiber: null,
      });

      const snapshots = yield* Fiber.join(collected);
      const last = snapshots.at(-1);
      expect(last?.phase).toBe("running");
      expect(last?.sequence).toBeGreaterThan(failedSequence);
    }),
  );

  it.effect("finished setups are dropped after the retention window", () =>
    Effect.gen(function* () {
      const tracker = yield* WorktreeSetupTracker.make;
      yield* tracker.begin({
        threadId,
        branch: null,
        baseRef: null,
        stages: ["agent"],
        fiber: null,
      });
      yield* tracker.finish(threadId, "done");
      expect((yield* tracker.get(threadId))?.phase).toBe("done");

      yield* TestClock.adjust(Duration.seconds(31));
      expect(yield* tracker.get(threadId)).toBeNull();
    }),
  );

  it.effect("cancel interrupts the bootstrap fiber and reports whether one was running", () =>
    Effect.gen(function* () {
      const tracker = yield* WorktreeSetupTracker.make;
      const started = yield* Deferred.make<void>();
      const fiber = yield* Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.forkChild,
      );
      yield* Deferred.await(started);
      yield* tracker.begin({ threadId, branch: null, baseRef: null, stages: ["agent"], fiber });

      expect(yield* tracker.cancel(threadId)).toBe(true);
      // cancel returns only after the bootstrap fiber has unwound.
      const exit = yield* Fiber.await(fiber);
      expect(Exit.hasInterrupts(exit)).toBe(true);

      yield* tracker.finish(threadId, "cancelled");
      expect(yield* tracker.cancel(threadId)).toBe(false);
      expect(yield* tracker.cancel(ThreadId.make("unknown"))).toBe(false);
    }),
  );

  it.effect("markUncancellable makes a later cancel a no-op while the setup keeps running", () =>
    Effect.gen(function* () {
      const tracker = yield* WorktreeSetupTracker.make;
      const fiber = yield* Effect.forkChild(Effect.never);
      yield* tracker.begin({ threadId, branch: null, baseRef: null, stages: ["agent"], fiber });

      yield* tracker.markUncancellable(threadId);
      expect(yield* tracker.cancel(threadId)).toBe(false);
      expect((yield* tracker.get(threadId))?.phase).toBe("running");
      yield* Fiber.interrupt(fiber);
    }),
  );

  it.effect("clamps free text to the contract limits before publishing", () =>
    Effect.gen(function* () {
      const tracker = yield* WorktreeSetupTracker.make;
      yield* tracker.begin({
        threadId,
        branch: null,
        baseRef: null,
        stages: ["checkout", "setup-script"],
        fiber: null,
      });
      const long = "x".repeat(2_000);

      yield* tracker.stageStatus(threadId, "checkout", "done", long);
      yield* tracker.stage(threadId, "setup-script", { detail: long });
      yield* tracker.appendTail(threadId, "setup-script", long);
      yield* tracker.finish(threadId, "failed", long);

      const snapshot = yield* tracker.get(threadId);
      expect(snapshot?.stages[0]?.detail?.length).toBe(200);
      expect(snapshot?.stages[1]?.detail?.length).toBe(200);
      expect(snapshot?.stages[1]?.tail[0]?.length).toBe(400);
      expect(snapshot?.error?.length).toBe(1000);
      // The wire schema must accept what the tracker publishes.
      expect(Schema.is(WorktreeSetupSnapshot)(snapshot)).toBe(true);
    }),
  );
});
