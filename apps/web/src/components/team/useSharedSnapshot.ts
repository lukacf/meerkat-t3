import type {
  EnvironmentId,
  SharedCheckout,
  SharedCheckoutPatch,
  SharedCheckoutRevision,
  SharedRevision,
  SharedSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import { useLayoutEffect, useRef, useState } from "react";
import { formatEnvironmentQueryError } from "../../state/query";
import { sharedWorkspaceEnvironment as shared } from "../../state/sharedWorkspace";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  assertSameSharedPatch,
  assertSharedSnapshot,
  assertSnapshotObservation,
  readySharedPatch,
  sharedPatchRevision,
} from "./sharedSnapshot";

type SnapshotSelection = {
  scope: string;
  preview: SharedCheckoutPatch;
  snapshot: SharedSnapshot | null;
};

/** Patch contents stay in memory until the person explicitly shares this preview. */
export function useSharedSnapshot(input: {
  hostEnvironmentId: EnvironmentId;
  accountKey: string;
  checkout: SharedCheckout | undefined;
  threadId?: ThreadId | undefined;
  maxBytes: number;
}) {
  const previewPatch = useAtomCommand(shared.previewCheckoutPatch, { reportFailure: false });
  const putSnapshot = useAtomCommand(shared.putSnapshot, { reportFailure: false });
  const [selection, setSelection] = useState<SnapshotSelection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scope = JSON.stringify([
    input.hostEnvironmentId,
    input.accountKey,
    input.checkout,
    input.threadId,
  ]);
  const activeScope = useRef<string | null>(scope);
  const scopeGeneration = useRef(0);
  // Cancel old async work during commit, before a response can resume against the new UI scope.
  useLayoutEffect(() => {
    activeScope.current = scope;
    scopeGeneration.current += 1;
    return () => {
      activeScope.current = null;
    };
  }, [scope]);
  const assertCurrentScope = (generation: number) => {
    if (activeScope.current !== scope || scopeGeneration.current !== generation)
      throw new Error("The selected account or checkout changed. Preview its changes again.");
  };
  const current = selection?.scope === scope ? selection : null;
  const capture = async (generation: number) => {
    assertCurrentScope(generation);
    if (!input.checkout) throw new Error("Select an attached local checkout first.");
    const result = await previewPatch({
      environmentId: input.checkout.localEnvironmentId,
      input: {
        projectId: input.checkout.localProjectId,
        ...(input.threadId ? { threadId: input.threadId } : {}),
      },
    });
    assertCurrentScope(generation);
    if (result._tag === "Failure") throw new Error(formatEnvironmentQueryError(result.cause));
    if (
      result.value.projectId !== input.checkout.localProjectId ||
      result.value.threadId !== input.threadId
    )
      throw new Error("The local backend returned another checkout's patch.");
    return result.value;
  };
  async function preview() {
    if (busy) return;
    const generation = scopeGeneration.current;
    setBusy(true);
    setError(null);
    try {
      const captured = await capture(generation);
      assertCurrentScope(generation);
      setSelection({ scope, preview: captured, snapshot: null });
    } catch (cause) {
      if (activeScope.current === scope && scopeGeneration.current === generation) {
        setSelection(null);
        setError(
          cause instanceof Error ? cause.message : "The local patch could not be previewed.",
        );
      }
    } finally {
      setBusy(false);
    }
  }
  async function share() {
    if (busy || !current || !input.checkout) return;
    const generation = scopeGeneration.current;
    setBusy(true);
    setError(null);
    try {
      readySharedPatch(current.preview, input.maxBytes);
      const fresh = await capture(generation);
      assertCurrentScope(generation);
      assertSameSharedPatch(current.preview, fresh);
      const result = await putSnapshot({
        environmentId: input.hostEnvironmentId,
        input: {
          checkoutId: input.checkout.checkoutId,
          revision: sharedPatchRevision(fresh),
          patch: fresh.patch!,
        },
      });
      assertCurrentScope(generation);
      if (result._tag === "Failure") throw new Error(formatEnvironmentQueryError(result.cause));
      assertSharedSnapshot(
        fresh,
        result.value,
        input.checkout.checkoutId,
        input.checkout.sharedProjectId,
      );
      setSelection({ scope, preview: fresh, snapshot: result.value });
    } catch (cause) {
      if (activeScope.current === scope && scopeGeneration.current === generation) {
        setSelection({ ...current, snapshot: null });
        setError(
          cause instanceof Error
            ? cause.message
            : "Snapshot sharing could not be confirmed. Retry the same preview.",
        );
      }
    } finally {
      setBusy(false);
    }
  }
  async function resolveRevision(observed: SharedCheckoutRevision): Promise<SharedRevision> {
    const generation = scopeGeneration.current;
    assertCurrentScope(generation);
    if (!input.checkout || observed.projectId !== input.checkout.localProjectId)
      throw new Error(
        "The local backend returned another project's revision. Nothing has been shared.",
      );
    if (!observed.branch) throw new Error("Choose a branch before sharing this request.");
    const revision: SharedRevision = {
      branch: observed.branch,
      commit: observed.commit,
      applicability: "branch",
    };
    if (!observed.dirty) {
      if (current?.snapshot)
        throw new Error(
          "The checkout is now clean. Refresh the preview to clear the earlier snapshot before sharing this revision.",
        );
      return revision;
    }
    if (!current?.snapshot)
      throw new Error(
        "This checkout has uncommitted changes. Preview and share a snapshot below, or commit them before continuing.",
      );
    assertSnapshotObservation(current.preview, observed);
    const fresh = await capture(generation);
    assertCurrentScope(generation);
    assertSameSharedPatch(current.preview, fresh);
    readySharedPatch(fresh, input.maxBytes);
    return { ...revision, snapshotId: current.snapshot.snapshotId };
  }
  return {
    preview: current?.preview ?? null,
    snapshot: current?.snapshot ?? null,
    busy,
    error,
    previewChanges: preview,
    shareSnapshot: share,
    resolveRevision,
  };
}
