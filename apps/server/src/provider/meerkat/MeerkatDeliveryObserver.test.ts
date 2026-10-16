import { describe, expect, it } from "@effect/vitest";
import { EventId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { ProviderAdapterValidationError } from "../Errors.ts";
import { makeMeerkatDeliveryObserver } from "./MeerkatDeliveryObserver.ts";
import type { MeerkatGatewayEvent } from "./MeerkatGatewayClient.ts";

const target = {
  threadId: ThreadId.make("thread"),
  mobId: "mob",
  projectPath: "/workspace",
  stateRoot: "/state",
};
const event = {
  event_id: "native-final",
  kind: "run.output.complete",
  thread_id: "thread",
  run_id: "run",
  timestamp: "2026-09-28T10:00:00.000Z",
  trace_id: "trace",
  payload: { text: "Final review", nativeSegmentId: "segment" },
};
function fixture() {
  const emitted: MeerkatGatewayEvent[] = [];
  const health: Array<string | undefined> = [];
  const pending = new Map<string, MeerkatGatewayEvent>([[event.event_id, event]]);
  const acknowledged: string[] = [];
  let failAck = false;
  let failRead = false;
  let bad = false;
  const observer = makeMeerkatDeliveryObserver({
    request: (method, params) =>
      Effect.gen(function* () {
        if (method === "mobs.v1.threadDeliveries") {
          if (failRead)
            return yield* new ProviderAdapterValidationError({
              provider: "meerkat",
              operation: "read",
              issue: "offline",
            });
          return { events: bad ? [{ ...event, thread_id: "other" }] : [...pending.values()] };
        }
        if (failAck)
          return yield* new ProviderAdapterValidationError({
            provider: "meerkat",
            operation: "ack",
            issue: "ack lost",
          });
        acknowledged.push(String(params.eventId));
        pending.delete(String(params.eventId));
        return { acknowledged: true };
      }),
    publish: (value) => {
      emitted.push(value);
    },
    health: (_, error) => {
      health.push(error);
    },
  });
  observer.observe(target);
  return {
    observer,
    emitted,
    health,
    pending,
    acknowledged,
    setFailAck: (value: boolean) => {
      failAck = value;
    },
    setFailRead: (value: boolean) => {
      failRead = value;
    },
    setBad: (value: boolean) => {
      bad = value;
    },
  };
}
describe("Meerkat durable output delivery", () => {
  it.effect("clears persisted failure after restart only when output can be read again", () =>
    Effect.gen(function* () {
      const beforeRestart = fixture();
      beforeRestart.setFailRead(true);
      yield* beforeRestart.observer.poll();
      expect(beforeRestart.health.at(-1)).toContain("offline");
      beforeRestart.observer.clear();

      const afterRestart = fixture();
      afterRestart.pending.clear();
      expect(afterRestart.health).toEqual([]);
      yield* afterRestart.observer.poll();
      yield* afterRestart.observer.poll();
      expect(afterRestart.health).toEqual([undefined]);
      expect(afterRestart.emitted).toEqual([]);
    }),
  );

  it.effect(
    "publishes a fresh health snapshot after a forgotten conversation is observed again",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        yield* f.observer.poll();
        f.observer.forget(target.threadId);
        f.setFailRead(true);
        f.observer.observe(target);
        expect(f.health).toEqual([undefined]);
        yield* f.observer.poll();
        expect(f.health.at(-1)).toContain("offline");
        f.setFailRead(false);
        yield* f.observer.poll();
        yield* f.observer.poll();
        expect(f.health).toHaveLength(3);
        expect(f.health.at(-1)).toBeUndefined();
      }),
  );

  it.effect("does not reintroduce stale failure after the observation is forgotten", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const health: Array<string | undefined> = [];
      const observer = makeMeerkatDeliveryObserver({
        request: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
            return yield* new ProviderAdapterValidationError({
              provider: "meerkat",
              operation: "read",
              issue: "old connection failed",
            });
          }),
        publish: () => {},
        health: (_, error) => {
          health.push(error);
        },
      });
      observer.observe(target);
      const poll = yield* observer.poll().pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(started);
      observer.forget(target.threadId);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(poll);
      expect(health).toEqual([]);
    }),
  );

  it.effect(
    "replays mixed output, terminal and skill receipts until each exact delivery is acknowledged",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        const resolved = {
          ...event,
          event_id: "skill-resolved",
          kind: "skills.resolved",
          payload: {
            nativeDeliveryId: "skill-resolved",
            nativeSourceEventId: "evt-agent-resolved",
            nativeSessionId: "session",
            nativeEvent: { payload: { type: "skills_resolved", skills: [], injection_bytes: 0 } },
          },
        };
        const failed = {
          ...resolved,
          event_id: "skill-failed",
          kind: "skills.resolution-failed",
          payload: {
            ...resolved.payload,
            nativeDeliveryId: "skill-failed",
            nativeSourceEventId: "evt-agent-failed",
            nativeEvent: {
              payload: {
                type: "skill_resolution_failed",
                skill_key: null,
                reason: { reason_type: "load", message: "source unavailable" },
              },
            },
          },
        };
        const terminal = {
          ...event,
          event_id: "native-terminal",
          kind: "run.completed",
          payload: {},
        };
        const page = [event, resolved, failed, terminal];
        for (const receipt of page) f.pending.set(receipt.event_id, receipt);
        yield* f.observer.poll();
        yield* f.observer.poll();
        expect(f.emitted).toEqual([...page, ...page]);
        expect(f.acknowledged).toEqual([]);
        yield* f.observer.acknowledge(EventId.make(resolved.event_id));
        f.setFailAck(true);
        yield* f.observer.acknowledge(EventId.make(failed.event_id));
        expect([...f.pending.keys()]).toEqual([event.event_id, failed.event_id, terminal.event_id]);
        f.setFailAck(false);
        yield* f.observer.poll();
        expect(f.emitted.slice(-3)).toEqual([event, failed, terminal]);
        for (const receipt of [failed, terminal, event])
          yield* f.observer.acknowledge(EventId.make(receipt.event_id));
        expect(f.acknowledged).toEqual([
          resolved.event_id,
          failed.event_id,
          terminal.event_id,
          event.event_id,
        ]);
        expect(f.pending.size).toBe(0);
      }),
  );
  it.effect("retains output through repeated reads and failed acknowledgement", () =>
    Effect.gen(function* () {
      const f = fixture();
      yield* f.observer.poll();
      yield* f.observer.poll();
      expect(f.emitted).toEqual([event, event]);
      f.setFailAck(true);
      yield* f.observer.acknowledge(EventId.make(event.event_id));
      expect(f.pending.size).toBe(1);
      yield* f.observer.poll();
      expect(f.emitted.at(-1)).toEqual(event);
      f.setFailAck(false);
      yield* f.observer.acknowledge(EventId.make(event.event_id));
      expect(f.pending.size).toBe(0);
      yield* f.observer.poll();
      expect(f.emitted).toHaveLength(3);
    }),
  );
  it.effect(
    "reports delivery failure and recovery once and refuses foreign conversation output",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        f.setFailRead(true);
        yield* f.observer.poll();
        yield* f.observer.poll();
        expect(f.health).toHaveLength(1);
        f.setFailRead(false);
        f.setBad(true);
        yield* f.observer.poll();
        expect(f.emitted).toHaveLength(0);
        expect(f.health).toHaveLength(2);
        f.setBad(false);
        yield* f.observer.poll();
        yield* f.observer.poll();
        expect(f.health.at(-1)).toBeUndefined();
        expect(f.health).toHaveLength(3);
        f.observer.forget(target.threadId);
        yield* f.observer.acknowledge(EventId.make(event.event_id));
        expect(f.pending.size).toBe(1);
      }),
  );
});
