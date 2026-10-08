import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

/** Per-target, conflated wakeups. Every delivery rereads durable state, including reconnects. */
export function makeMeerkatStateSubscriptions() {
  type Source = "mutation" | "observation";
  const listeners = new Map<string, Set<PubSub.PubSub<Source>>>();
  const publish = (key: string, source: Source = "mutation") =>
    Effect.suspend(() =>
      Effect.forEach(listeners.get(key) ?? [], (mailbox) => PubSub.publish(mailbox, source), {
        discard: true,
      }),
    );
  const subscribe = <A, E, R>(key: string, read: Effect.Effect<A, E, R>) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const mailbox = yield* PubSub.sliding<Source>(1);
        const subscription = yield* PubSub.subscribe(mailbox);
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const scoped = listeners.get(key) ?? new Set<PubSub.PubSub<Source>>();
            scoped.add(mailbox);
            listeners.set(key, scoped);
            return scoped;
          }),
          (scoped) =>
            Effect.sync(() => {
              scoped.delete(mailbox);
              if (scoped.size === 0) listeners.delete(key);
            }).pipe(Effect.andThen(PubSub.shutdown(mailbox))),
        );
        const snapshot = yield* read;
        return Stream.concat(
          Stream.make(
            { kind: "snapshot" as const, source: "initial" as const, snapshot },
            { kind: "synchronized" as const },
          ),
          Stream.fromSubscription(subscription).pipe(
            Stream.mapEffect((source) =>
              read.pipe(
                Effect.map((next) => ({ kind: "snapshot" as const, source, snapshot: next })),
              ),
            ),
          ),
        );
      }),
    );
  return { publish, subscribe, keys: () => [...listeners.keys()] };
}
