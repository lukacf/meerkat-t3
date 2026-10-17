import { SharedWorkspaceError, type SharedDelegationRegisterInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { VcsProcess } from "../vcs/VcsProcess.ts";
import { makeSharedCheckoutRevision } from "./SharedCheckoutRevision.ts";
import type {
  SharedDelegationRemote,
  SharedRemoteConnection,
} from "./SharedLocalDelegationService.ts";

export type SharedLocalCheckoutValidator = (
  connection: SharedRemoteConnection,
  registration: SharedDelegationRegisterInput,
) => Effect.Effect<void, SharedWorkspaceError>;

/** New admission only. Retained retries keep the original immutable task context. */
export const makeSharedLocalCheckoutValidator = Effect.fn("SharedLocalCheckoutValidator.make")(
  function* (remote: Pick<SharedDelegationRemote, "context">) {
    const checkout = yield* makeSharedCheckoutRevision;
    const vcs = yield* VcsProcess;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const validate: SharedLocalCheckoutValidator = Effect.fn(
      "SharedLocalCheckoutValidator.validate",
    )(function* (connection, registration) {
      const proof = yield* remote.context(connection, {
        contextId: registration.contextId,
        contextVersion: registration.contextVersion,
      });
      const { context, snapshot } = proof;
      const binding = registration.binding;
      const invalid = () =>
        new SharedWorkspaceError({
          code: "conflict",
          message:
            "The task checkout no longer matches the shared context. Preview and share its current revision before enabling access.",
        });
      if (
        !connection.expected ||
        context.contextId !== registration.contextId ||
        context.contextVersion !== registration.contextVersion ||
        context.participantId !== connection.expected.participantId ||
        context.checkoutId !== proof.checkout.checkoutId ||
        proof.checkout.participantId !== connection.expected.participantId ||
        context.sharedProjectId !== proof.checkout.sharedProjectId ||
        proof.checkout.localEnvironmentId !== binding.environmentId ||
        proof.checkout.localProjectId !== binding.projectId ||
        context.source.kind !== "thread" ||
        context.source.threadId !== binding.threadId
      )
        return yield* invalid();
      const target = { projectId: binding.projectId, threadId: binding.threadId };
      // Capture uses the host-resolved task worktree and includes tracked contents in
      // the stable digest. Untracked/unsupported coverage cannot authorize a grant.
      const local = yield* checkout
        .patch(target)
        .pipe(
          Effect.provideService(VcsProcess, vcs),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.mapError(invalid),
        );
      if (
        local.branch !== context.revision.branch ||
        local.commit !== context.revision.commit ||
        local.status === "unsupported"
      )
        return yield* invalid();
      if (context.revision.snapshotId) {
        if (
          local.status !== "ready" ||
          !snapshot ||
          snapshot.snapshotId !== context.revision.snapshotId ||
          snapshot.checkoutId !== proof.checkout.checkoutId ||
          snapshot.sharedProjectId !== context.sharedProjectId ||
          snapshot.revision.branch !== local.branch ||
          snapshot.revision.commit !== local.commit ||
          snapshot.sha256 !== local.sha256 ||
          snapshot.bytes !== local.bytes
        )
          return yield* invalid();
      } else if (local.status !== "clean" || snapshot) return yield* invalid();
    });
    return validate;
  },
);
