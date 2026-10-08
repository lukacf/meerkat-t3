import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { makeMeerkatStateSubscriptions } from "./MeerkatStateSubscriptions.ts";

describe("durable state subscriptions", () => {
  it.effect("retains a change committed while the initial snapshot is being read", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const state = makeMeerkatStateSubscriptions();
        const reading = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let value = 0;
        let first = true;
        const read = Effect.gen(function* () {
          const snapshot = value;
          if (first) {
            first = false;
            yield* Deferred.succeed(reading, undefined);
            yield* Deferred.await(release);
          }
          return snapshot;
        });
        const events = yield* Stream.toQueue(state.subscribe("target", read), { capacity: 4 });
        yield* Deferred.await(reading);
        value = 1;
        yield* state.publish("target");
        yield* Deferred.succeed(release, undefined);
        expect(yield* Queue.take(events)).toEqual({
          kind: "snapshot",
          source: "initial",
          snapshot: 0,
        });
        expect(yield* Queue.take(events)).toEqual({ kind: "synchronized" });
        expect(yield* Queue.take(events)).toEqual({
          kind: "snapshot",
          source: "mutation",
          snapshot: 1,
        });
      }),
    ),
  );

  it.effect(
    "keeps the latest own-target state when a slow consumer misses intermediate changes",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const state = makeMeerkatStateSubscriptions();
          const reading = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          let value = 0;
          const read = Effect.gen(function* () {
            const snapshot = value;
            if (snapshot === 1) {
              yield* Deferred.succeed(reading, undefined);
              yield* Deferred.await(release);
            }
            return snapshot;
          });
          const events = yield* Stream.toQueue(state.subscribe("target", read), { capacity: 4 });
          yield* Queue.take(events);
          yield* Queue.take(events);
          value = 1;
          yield* state.publish("target");
          yield* Deferred.await(reading);
          value = 2;
          yield* state.publish("target");
          value = 3;
          yield* state.publish("target", "observation");
          yield* state.publish("other-target");
          yield* Deferred.succeed(release, undefined);
          expect(yield* Queue.take(events)).toEqual({
            kind: "snapshot",
            source: "mutation",
            snapshot: 1,
          });
          expect(yield* Queue.take(events)).toEqual({
            kind: "snapshot",
            source: "observation",
            snapshot: 3,
          });
        }),
      ),
  );
});
