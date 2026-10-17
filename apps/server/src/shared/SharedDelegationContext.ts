import {
  SharedWorkspaceError,
  type SharedDelegationContext,
  type SharedDelegationContextInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { SharedWorkspaceStore } from "./SharedWorkspaceStore.ts";

/** No patch bytes or unrelated participant context are exposed by this broker proof. */
export const sharedDelegationContext = (
  store: Pick<SharedWorkspaceStore, "requireParticipant" | "context" | "checkout" | "getSnapshot">,
  sessionId: string,
  input: SharedDelegationContextInput,
) =>
  Effect.gen(function* () {
    const owner = yield* store.requireParticipant(sessionId);
    const context = yield* store.context(input.contextId, input.contextVersion);
    const checkout = yield* store.checkout(context.checkoutId);
    if (
      owner.kind !== "person" ||
      context.participantId !== owner.participantId ||
      checkout.participantId !== owner.participantId ||
      context.sharedProjectId !== checkout.sharedProjectId
    )
      return yield* new SharedWorkspaceError({
        code: "forbidden",
        message: "This immutable context belongs to another participant.",
      });
    const snapshot = context.revision.snapshotId
      ? (yield* store.getSnapshot(context.revision.snapshotId)).snapshot
      : null;
    if (
      snapshot &&
      (snapshot.checkoutId !== checkout.checkoutId ||
        snapshot.sharedProjectId !== checkout.sharedProjectId ||
        snapshot.revision.branch !== context.revision.branch ||
        snapshot.revision.commit !== context.revision.commit)
    )
      return yield* new SharedWorkspaceError({
        code: "conflict",
        message: "The retained snapshot does not match this context and checkout.",
      });
    return { context, checkout, snapshot } satisfies SharedDelegationContext;
  }).pipe(
    Effect.mapError((error) =>
      Schema.is(SharedWorkspaceError)(error)
        ? error
        : new SharedWorkspaceError({
            code: "unavailable",
            message: "The retained context proof is unavailable.",
          }),
    ),
  );
