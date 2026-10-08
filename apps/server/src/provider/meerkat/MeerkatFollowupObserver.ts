import {
  ConsoleFrame,
  EventId,
  RuntimeItemId,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import { ProviderAdapterValidationError, type ProviderAdapterError } from "../Errors.ts";

const Page = Schema.Struct({
  status: Schema.Literals(["ready", "paused", "needs_baseline", "needs_recovery", "unavailable"]),
  sessionId: Schema.optional(Schema.String),
  frames: Schema.Array(ConsoleFrame),
  nextCursor: Schema.optional(Schema.String),
  exhausted: Schema.Boolean,
});
const Completion = Schema.Struct({
  result: Schema.String,
  source_event_type: Schema.Literals(["run_completed", "interaction_complete"]),
});
const decodePage = Schema.decodeUnknownEffect(Page);
const decodeCompletion = Schema.decodeUnknownEffect(Completion);

export interface MeerkatFollowupTarget {
  readonly threadId: ThreadId;
  readonly mobId: string;
  readonly projectPath: string;
  readonly stateRoot: string;
}

interface Observation {
  readonly target: MeerkatFollowupTarget;
  sessionId?: string;
  after?: string;
  pending?: {
    readonly events: Map<EventId, ProviderRuntimeEvent>;
    readonly nextCursor?: string;
  };
  error?: string;
  emptyReads?: number;
  nextReadAt?: number;
}

/** Read-only native replay. A published page is retained until ingestion confirms persistence. */
export function makeMeerkatFollowupObserver(options: {
  readonly instanceId: ProviderInstanceId;
  /** Injectable clock for deterministic polling measurements. */
  readonly now?: () => number;
  readonly read: (
    params: MeerkatFollowupTarget & { readonly after?: string },
  ) => Effect.Effect<unknown, ProviderAdapterError>;
  readonly publish: (event: ProviderRuntimeEvent) => void;
}) {
  const observations = new Map<ThreadId, Observation>();
  const now = options.now ?? (() => performance.now());
  const pendingOwners = new Map<EventId, Observation>();
  const invalid = (issue: string) =>
    new ProviderAdapterValidationError({
      provider: "meerkat",
      operation: "threadFollowups",
      issue,
    });
  const release = (observation: Observation) => {
    for (const id of observation.pending?.events.keys() ?? []) pendingOwners.delete(id);
  };
  const advance = (observation: Observation) => {
    if (!observation.pending || observation.pending.events.size > 0) return;
    if (observation.pending.nextCursor) observation.after = observation.pending.nextCursor;
    delete observation.pending;
  };
  const observe = (target: MeerkatFollowupTarget) => {
    const previous = observations.get(target.threadId);
    if (
      previous?.target.mobId === target.mobId &&
      previous.target.projectPath === target.projectPath &&
      previous.target.stateRoot === target.stateRoot
    )
      return;
    if (previous) release(previous);
    observations.set(target.threadId, { target });
  };
  const forget = (threadId: ThreadId) => {
    const observation = observations.get(threadId);
    if (observation) release(observation);
    observations.delete(threadId);
  };
  const acknowledge = (eventId: EventId) => {
    const observation = pendingOwners.get(eventId);
    if (!observation) return;
    observation.pending?.events.delete(eventId);
    pendingOwners.delete(eventId);
    advance(observation);
  };
  const read = Effect.fn("MeerkatFollowupObserver.read")(function* (observation: Observation) {
    advance(observation);
    if (!observation.pending) {
      const page = yield* options
        .read({
          ...observation.target,
          ...(observation.after ? { after: observation.after } : {}),
        })
        .pipe(
          Effect.flatMap(decodePage),
          Effect.mapError((cause) => invalid(cause.message)),
        );
      if (observations.get(observation.target.threadId) !== observation) return;
      if (page.status === "paused" || page.status === "unavailable") return;
      if (page.status === "needs_baseline") {
        return yield* invalid("Existing coordinator history needs an audited replay boundary.");
      }
      if (page.status === "needs_recovery") {
        return yield* invalid(
          "An interrupted coordinator input needs its native completion attribution recovered before follow-ups can replay.",
        );
      }
      if (!page.sessionId || (observation.sessionId && observation.sessionId !== page.sessionId)) {
        return yield* invalid("The coordinator session changed during native history observation.");
      }
      if (page.frames.length > 100)
        return yield* invalid("Native history exceeded its page bound.");
      const cursor = (value: string) =>
        /^console:\d+$/.test(value) ? BigInt(value.slice(8)) : undefined;
      if (
        page.nextCursor &&
        (cursor(page.nextCursor) === undefined ||
          (observation.after && cursor(page.nextCursor)! < cursor(observation.after)!))
      )
        return yield* invalid("Native history returned an invalid replay cursor.");
      if (!page.exhausted && (!page.nextCursor || page.nextCursor === observation.after)) {
        return yield* invalid("Native history paging did not advance.");
      }
      const events = new Map<EventId, ProviderRuntimeEvent>();
      for (const frame of page.frames) {
        if (
          frame.session_id !== page.sessionId ||
          frame.identity !== "ingress" ||
          frame.runtime_key !== "default" ||
          frame.kind !== "interaction_complete" ||
          frame.status !== "completed" ||
          frame.source.kind !== "console_event"
        )
          return yield* invalid(
            "Native history returned a response outside the coordinator scope.",
          );
        const completion = yield* decodeCompletion(frame.payload).pipe(
          Effect.mapError((cause) => invalid(cause.message)),
        );
        if (frame.timestamp_ms > 8_640_000_000_000_000)
          return yield* invalid("Native history returned an invalid response timestamp.");
        if (!completion.result.trim()) continue;
        const id = EventId.make(
          `meerkat-followup:${options.instanceId}:${observation.target.mobId}:${page.sessionId}:${frame.id}`,
        );
        events.set(id, {
          provider: ProviderDriverKind.make("meerkat"),
          providerInstanceId: options.instanceId,
          threadId: observation.target.threadId,
          eventId: id,
          itemId: RuntimeItemId.make(id),
          createdAt: DateTime.formatIso(DateTime.makeUnsafe(frame.timestamp_ms)),
          type: "item.completed",
          payload: {
            itemType: "assistant_message",
            status: "completed",
            authoritativeText: completion.result,
          },
        });
      }
      // The durable cursor remains the authority. Only repeated exhausted reads
      // with no new frames or cursor progress may wait longer. Keep catch-up
      // and unacknowledged delivery at the normal polling cadence.
      const unchanged =
        page.frames.length === 0 &&
        page.exhausted &&
        (page.nextCursor === undefined || page.nextCursor === observation.after);
      observation.emptyReads = unchanged ? Math.min((observation.emptyReads ?? 0) + 1, 4) : 0;
      observation.nextReadAt = unchanged
        ? now() + Math.min(5_000, 1_000 * 2 ** (observation.emptyReads - 1))
        : 0;
      observation.sessionId = page.sessionId;
      observation.pending = { events, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
      for (const id of events.keys()) pendingOwners.set(id, observation);
      advance(observation);
    }
    if (observations.get(observation.target.threadId) !== observation) return;
    for (const event of observation.pending?.events.values() ?? []) options.publish(event);
    delete observation.error;
  });
  const poll = Effect.fn("MeerkatFollowupObserver.poll")(function* () {
    yield* Effect.forEach(
      [...observations.values()].filter(
        (observation) => observation.pending || (observation.nextReadAt ?? 0) <= now(),
      ),
      (observation) =>
        read(observation).pipe(
          Effect.catch((cause) => {
            const message = cause.message;
            if (observation.error === message) return Effect.void;
            observation.error = message;
            return Effect.logWarning("Meerkat coordinator history could not be reconciled", {
              threadId: observation.target.threadId,
              error: message,
            });
          }),
        ),
      { concurrency: 4 },
    );
  });
  return {
    observe,
    refreshAfterTurnAdmission: (target: MeerkatFollowupTarget) => {
      // An explicit admitted input may establish a replacement native session.
      // Replay from its durable boundary; stable event IDs keep same-session
      // replays idempotent even when earlier deliveries are still in flight.
      forget(target.threadId);
      observe(target);
    },
    forget,
    acknowledge,
    poll,
    clear: () => {
      observations.clear();
      pendingOwners.clear();
    },
  };
}
