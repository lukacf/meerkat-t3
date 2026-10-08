import { describe, expect, it } from "@effect/vitest";
import {
  EventId,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { ProviderAdapterValidationError } from "../Errors.ts";
import { makeMeerkatFollowupObserver } from "./MeerkatFollowupObserver.ts";

const target = {
  threadId: ThreadId.make("thread-1"),
  mobId: "mob-1",
  projectPath: "/workspace",
  stateRoot: "/state",
};
const frame = (id: string, seq: number, sessionId = "session-1") => ({
  id,
  cursor: `console:${seq}`,
  dedupe_key: id,
  timestamp_ms: 1_790_408_996_000 + seq,
  runtime_key: "default",
  identity: "ingress",
  session_id: sessionId,
  kind: "interaction_complete",
  status: "completed",
  frame_version: 1,
  payload: { result: "Review complete", source_event_type: "run_completed" },
  source: { kind: "console_event" },
});
function fixture() {
  const emitted: ProviderRuntimeEvent[] = [];
  const reads: Array<{ after?: string }> = [];
  let page: unknown = {
    status: "ready",
    sessionId: "session-1",
    frames: [frame("native-1", 1)],
    nextCursor: "console:1",
    exhausted: true,
  };
  let fail = false;
  const observer = makeMeerkatFollowupObserver({
    instanceId: ProviderInstanceId.make("meerkat"),
    publish: (event) => {
      emitted.push(event);
    },
    read: (params) =>
      Effect.gen(function* () {
        reads.push(params);
        if (fail)
          return yield* new ProviderAdapterValidationError({
            provider: "meerkat",
            operation: "test",
            issue: "read failed",
          });
        return page;
      }),
  });
  observer.observe(target);
  return {
    observer,
    emitted,
    reads,
    setPage: (value: unknown) => {
      page = value;
    },
    setFail: (value: boolean) => {
      fail = value;
    },
  };
}

describe("Meerkat coordinator follow-up replay", () => {
  it.effect("retries the same response until persistence is acknowledged before advancing", () =>
    Effect.gen(function* () {
      const f = fixture();
      yield* f.observer.poll();
      yield* f.observer.poll();
      expect(f.reads).toHaveLength(1);
      expect(f.emitted).toHaveLength(2);
      expect(f.emitted[0]).toEqual(f.emitted[1]);
      expect(f.emitted[0]?.turnId).toBeUndefined();
      f.observer.acknowledge(f.emitted[0]!.eventId);
      f.setPage({
        status: "ready",
        sessionId: "session-1",
        frames: [frame("native-2", 2)],
        nextCursor: "console:2",
        exhausted: true,
      });
      yield* f.observer.poll();
      expect(f.reads[1]?.after).toBe("console:1");
      expect(f.emitted[2]?.eventId).not.toBe(f.emitted[0]?.eventId);
      expect(f.emitted[2]?.payload).toEqual(f.emitted[0]?.payload);
    }),
  );

  it.effect("recreates identical delivery identity across a cold observer restart", () =>
    Effect.gen(function* () {
      const first = fixture();
      yield* first.observer.poll();
      first.observer.acknowledge(first.emitted[0]!.eventId);
      first.observer.clear();
      const restarted = fixture();
      yield* restarted.observer.poll();
      expect(restarted.emitted[0]).toEqual(first.emitted[0]);
    }),
  );

  it.effect("retains the cursor on failed reads and rejects foreign or changed sessions", () =>
    Effect.gen(function* () {
      const f = fixture();
      f.setFail(true);
      yield* f.observer.poll();
      expect(f.emitted).toHaveLength(0);
      f.setFail(false);
      f.setPage({
        status: "ready",
        sessionId: "session-1",
        frames: [frame("foreign", 2, "foreign-session")],
        nextCursor: "console:2",
        exhausted: true,
      });
      yield* f.observer.poll();
      expect(f.emitted).toHaveLength(0);
      f.setPage({
        status: "ready",
        sessionId: "session-1",
        frames: [frame("native-1", 1)],
        nextCursor: "console:1",
        exhausted: true,
      });
      yield* f.observer.poll();
      f.observer.acknowledge(f.emitted[0]!.eventId);
      f.setPage({
        status: "ready",
        sessionId: "new-session",
        frames: [frame("replacement", 2, "new-session")],
        nextCursor: "console:2",
        exhausted: true,
      });
      yield* f.observer.poll();
      expect(f.emitted).toHaveLength(1);
      expect(f.reads.at(-1)?.after).toBe("console:1");
    }),
  );

  it.effect("pauses for app-owned work or legacy history without advancing replay", () =>
    Effect.gen(function* () {
      const f = fixture();
      for (const status of ["paused", "needs_baseline", "needs_recovery"]) {
        f.setPage({ status, frames: [], exhausted: true, nextCursor: "console:99" });
        yield* f.observer.poll();
      }
      expect(f.emitted).toHaveLength(0);
      f.setPage({
        status: "ready",
        sessionId: "session-1",
        frames: [frame("native-1", 1)],
        nextCursor: "console:1",
        exhausted: true,
      });
      yield* f.observer.poll();
      expect(f.reads.at(-1)?.after).toBeUndefined();
      expect(f.emitted).toHaveLength(1);
    }),
  );

  it.effect("forgets removed threads and their unacknowledged page", () =>
    Effect.gen(function* () {
      const f = fixture();
      yield* f.observer.poll();
      f.observer.forget(target.threadId);
      f.observer.acknowledge(f.emitted[0]!.eventId);
      yield* f.observer.poll();
      expect(f.reads).toHaveLength(1);
      expect(f.emitted).toHaveLength(1);
      f.observer.observe(target);
      yield* f.observer.poll();
      expect(f.reads[1]?.after).toBeUndefined();
      expect(f.emitted[1]).toEqual(f.emitted[0]);
    }),
  );

  it.effect("accepts a replacement session only after explicit turn admission refresh", () =>
    Effect.gen(function* () {
      const f = fixture();
      yield* f.observer.poll();
      const oldEvent = f.emitted[0]!;
      f.observer.refreshAfterTurnAdmission(target);
      // An old queued acknowledgment cannot advance the new observation.
      f.observer.acknowledge(oldEvent.eventId);
      f.setPage({
        status: "ready",
        sessionId: "session-2",
        frames: [frame("replacement", 2, "session-2")],
        nextCursor: "console:2",
        exhausted: true,
      });
      yield* f.observer.poll();
      expect(f.reads.at(-1)?.after).toBeUndefined();
      expect(f.emitted).toHaveLength(2);
      expect(f.emitted[1]?.eventId).not.toBe(oldEvent.eventId);
      expect(f.emitted[1]?.threadId).toBe(target.threadId);
      f.observer.acknowledge(oldEvent.eventId);
      yield* f.observer.poll();
      expect(f.reads).toHaveLength(2);
      expect(f.emitted[2]).toEqual(f.emitted[1]);
    }),
  );

  it.effect("replays identical stable identities after same-session admission refresh", () =>
    Effect.gen(function* () {
      const f = fixture();
      yield* f.observer.poll();
      f.observer.acknowledge(f.emitted[0]!.eventId);
      f.observer.refreshAfterTurnAdmission(target);
      yield* f.observer.poll();
      expect(f.reads.at(-1)?.after).toBeUndefined();
      expect(f.emitted[1]).toEqual(f.emitted[0]);
    }),
  );

  it.effect("rejects malformed timestamps without stopping subsequent reconciliation", () =>
    Effect.gen(function* () {
      const f = fixture();
      f.setPage({
        status: "ready",
        sessionId: "session-1",
        frames: [{ ...frame("bad-time", 1), timestamp_ms: 9_000_000_000_000_000 }],
        nextCursor: "console:1",
        exhausted: true,
      });
      yield* f.observer.poll();
      expect(f.emitted).toHaveLength(0);
      f.setPage({
        status: "ready",
        sessionId: "session-1",
        frames: [frame("valid", 2)],
        nextCursor: "console:2",
        exhausted: true,
      });
      yield* f.observer.poll();
      expect(f.emitted).toHaveLength(1);
      expect(f.reads.at(-1)?.after).toBeUndefined();
    }),
  );

  it.effect("waits for every response in a page and ignores unrelated acknowledgments", () =>
    Effect.gen(function* () {
      const f = fixture();
      f.setPage({
        status: "ready",
        sessionId: "session-1",
        frames: [frame("native-1", 1), frame("native-2", 2)],
        nextCursor: "console:2",
        exhausted: false,
      });
      yield* f.observer.poll();
      f.observer.acknowledge(EventId.make("foreign"));
      f.observer.acknowledge(f.emitted[0]!.eventId);
      yield* f.observer.poll();
      expect(f.reads).toHaveLength(1);
      expect(f.emitted).toHaveLength(3);
      expect(f.emitted[2]?.eventId).toBe(f.emitted[1]?.eventId);
      f.observer.acknowledge(f.emitted[1]!.eventId);
      f.setPage({
        status: "ready",
        sessionId: "session-1",
        frames: [],
        nextCursor: "console:3",
        exhausted: true,
      });
      yield* f.observer.poll();
      expect(f.reads.at(-1)?.after).toBe("console:2");
    }),
  );
});

describe("idle replay cadence", () => {
  it.effect(
    "reduces empty native reads and still discovers an unsolicited reply within five seconds",
    () =>
      Effect.gen(function* () {
        let now = 0,
          reads = 0,
          ready = false;
        const emitted: ProviderRuntimeEvent[] = [];
        const observer = makeMeerkatFollowupObserver({
          instanceId: ProviderInstanceId.make("native"),
          now: () => now,
          read: () =>
            Effect.sync(() => {
              reads++;
              return {
                status: "ready",
                sessionId: "session-1",
                frames: ready ? [frame("fresh", 1)] : [],
                ...(ready ? { nextCursor: "console:1" } : {}),
                exhausted: true,
              };
            }),
          publish: (event) => emitted.push(event),
        });
        observer.observe(target);
        for (now = 0; now < 30_000; now += 1_000) yield* observer.poll();
        expect(reads).toBeLessThanOrEqual(9);
        expect(emitted).toHaveLength(0);
        ready = true;
        const arrival = now;
        while (emitted.length === 0 && now - arrival <= 5_000) {
          yield* observer.poll();
          now += 1_000;
        }
        expect(emitted).toHaveLength(1);
        expect(now - arrival).toBeLessThanOrEqual(5_000);
        const beforeRetry = reads;
        yield* observer.poll();
        expect(reads).toBe(beforeRetry);
        expect(emitted).toHaveLength(2);
      }),
  );
  it.effect("does not throttle a catch-up cursor even when a page contains no completion", () =>
    Effect.gen(function* () {
      let reads = 0;
      const observer = makeMeerkatFollowupObserver({
        instanceId: ProviderInstanceId.make("native"),
        now: () => 0,
        read: () =>
          Effect.sync(() => ({
            status: "ready",
            sessionId: "session-1",
            frames: [],
            nextCursor: `console:${++reads}`,
            exhausted: false,
          })),
        publish: () => {},
      });
      observer.observe(target);
      for (let i = 0; i < 4; i++) yield* observer.poll();
      expect(reads).toBe(4);
    }),
  );
  it.effect(
    "turn admission and scope replacement wake an idle observation without dropping the durable boundary",
    () =>
      Effect.gen(function* () {
        let reads = 0;
        const observer = makeMeerkatFollowupObserver({
          instanceId: ProviderInstanceId.make("native"),
          now: () => 0,
          read: () =>
            Effect.sync(() => {
              reads++;
              return {
                status: "ready",
                sessionId: "session-1",
                frames: [],
                nextCursor: "console:0",
                exhausted: true,
              };
            }),
          publish: () => {},
        });
        observer.observe(target);
        yield* observer.poll();
        yield* observer.poll();
        yield* observer.poll();
        expect(reads).toBe(2);
        observer.refreshAfterTurnAdmission(target);
        yield* observer.poll();
        expect(reads).toBe(3);
        observer.observe({ ...target, stateRoot: "/replacement" });
        yield* observer.poll();
        expect(reads).toBe(4);
      }),
  );
});
