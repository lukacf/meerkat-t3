import { EventId, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { MeerkatGatewayEvent } from "./MeerkatGatewayClient.ts";
import type { MeerkatFollowupTarget } from "./MeerkatFollowupObserver.ts";
import { ProviderAdapterValidationError, type ProviderAdapterError } from "../Errors.ts";

const Delivery = Schema.Struct({
  event_id: Schema.String,
  kind: Schema.Literals([
    "run.output.complete",
    "run.completed",
    "run.failed",
    "run.cancelled",
    "skills.resolved",
    "skills.resolution-failed",
  ]),
  timestamp: Schema.String,
  thread_id: Schema.String,
  run_id: Schema.String,
  trace_id: Schema.String,
  payload: Schema.Record(Schema.String, Schema.Unknown),
});
const Page = Schema.Struct({ events: Schema.Array(Delivery) });

/** Pending output is owned by the native outbox until orchestration acknowledges persistence. */
export function makeMeerkatDeliveryObserver(options: {
  readonly request: (
    method: string,
    params: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<unknown, ProviderAdapterError>;
  readonly publish: (event: MeerkatGatewayEvent) => void;
  readonly health: (target: MeerkatFollowupTarget, error?: string) => void;
}) {
  const targets = new Map<ThreadId, MeerkatFollowupTarget>();
  const owners = new Map<EventId, MeerkatFollowupTarget>();
  // Health events are persisted with the conversation. Publish the initial
  // successful read too, so restarting the observer can clear an old failure.
  const lastHealth = new Map<ThreadId, string | null>();
  const observe = (target: MeerkatFollowupTarget) => {
    targets.set(target.threadId, target);
  };
  const forget = (thread: ThreadId) => {
    targets.delete(thread);
    lastHealth.delete(thread);
    for (const [id, target] of owners) if (target.threadId === thread) owners.delete(id);
  };
  const track = (id: EventId, target: MeerkatFollowupTarget) => {
    owners.set(id, target);
  };
  const acknowledge = Effect.fn("MeerkatDeliveryObserver.acknowledge")(function* (id: EventId) {
    const target = owners.get(id);
    if (!target) return;
    yield* options.request("mobs.v1.acknowledgeThreadDelivery", { ...target, eventId: id }).pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(Schema.Struct({ acknowledged: Schema.Literal(true) })),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          owners.delete(id);
        }),
      ),
      Effect.catch((error) =>
        Effect.logWarning("Meerkat output acknowledgement will retry", {
          threadId: target.threadId,
          error: error.message,
        }),
      ),
    );
  });
  const poll = Effect.fn("MeerkatDeliveryObserver.poll")(function* () {
    yield* Effect.forEach(
      [...targets.values()],
      (target) =>
        Effect.gen(function* () {
          const page = yield* options
            .request("mobs.v1.threadDeliveries", { ...target })
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Page)));
          if (page.events.length > 100)
            return yield* new ProviderAdapterValidationError({
              provider: "meerkat",
              operation: "threadDeliveries",
              issue: "Native output exceeded its page bound.",
            });
          for (const event of page.events) {
            if (
              event.thread_id !== target.threadId ||
              !event.run_id ||
              !Number.isFinite(Date.parse(event.timestamp))
            ) {
              return yield* new ProviderAdapterValidationError({
                provider: "meerkat",
                operation: "threadDeliveries",
                issue: "Native output did not match its conversation.",
              });
            }
          }
          if (targets.get(target.threadId) !== target) return;
          for (const event of page.events) {
            track(EventId.make(event.event_id), target);
            options.publish(event);
          }
          if (lastHealth.get(target.threadId) !== null) {
            lastHealth.set(target.threadId, null);
            options.health(target);
          }
        }).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              if (targets.get(target.threadId) !== target) return;
              if (lastHealth.get(target.threadId) !== error.message) {
                lastHealth.set(target.threadId, error.message);
                options.health(target, error.message);
              }
            }),
          ),
        ),
      { concurrency: 4 },
    );
  });
  return {
    observe,
    forget,
    track,
    acknowledge,
    poll,
    clear: () => {
      targets.clear();
      owners.clear();
      lastHealth.clear();
    },
  };
}
