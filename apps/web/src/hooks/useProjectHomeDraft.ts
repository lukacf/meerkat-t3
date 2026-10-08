import { scopeProjectRef, scopedProjectKey } from "@t3tools/client-runtime/environment";
import { ProviderInstanceId, type ScopedProjectRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useEffect, useState } from "react";

import { useComposerDraftStore, type DraftId } from "../composerDraftStore";
import { hasExplicitComposerModelSelection } from "../lib/chatThreadActions";
import { useProjects } from "../state/entities";
import { useEnvironments } from "../state/environments";
import { useNewThreadHandler } from "./useHandleNewThread";
import { getLocalStorageItem, removeLocalStorageItem } from "./useLocalStorage";

const PreviousHomeModelSelection = Schema.NullOr(
  Schema.Struct({ instanceId: ProviderInstanceId, model: Schema.NullOr(Schema.String) }),
);

function migrateProjectHomeDraft(projectRef: ScopedProjectRef, draftId: DraftId) {
  const suffix = `${projectRef.environmentId}:${projectRef.projectId}`;
  const promptKey = `t3code:project-start-prompt:${suffix}`;
  const modelKey = `t3code:project-start-model:${suffix}`;
  const drafts = useComposerDraftStore.getState();
  // Preserve work entered in the earlier home screen while moving its editor
  // into the canonical draft. Existing composer work always wins.
  try {
    const prompt = getLocalStorageItem(promptKey, Schema.String);
    if (prompt && !drafts.getComposerDraft(draftId)?.prompt) {
      drafts.setPrompt(draftId, prompt);
      removeLocalStorageItem(promptKey);
    }
    const model = getLocalStorageItem(modelKey, PreviousHomeModelSelection);
    if (model?.model) {
      if (!hasExplicitComposerModelSelection(drafts.getComposerDraft(draftId))) {
        drafts.setModelSelection(
          draftId,
          { instanceId: model.instanceId, model: model.model },
          { replaceOptions: true },
        );
      }
      removeLocalStorageItem(modelKey);
    }
  } catch {
    // A corrupt legacy preference cannot prevent opening the real composer.
  }
}

export function useProjectHomeDraft(projectRef: ScopedProjectRef | null) {
  const openDraft = useNewThreadHandler();
  const project = useProjects().find(
    (entry) =>
      entry.environmentId === projectRef?.environmentId && entry.id === projectRef?.projectId,
  );
  const { environments } = useEnvironments();
  const environmentId = projectRef?.environmentId;
  const projectId = projectRef?.projectId;
  const environment = environments.find((entry) => entry.environmentId === environmentId);
  const ready = Boolean(project && environment?.serverConfig);
  const hasExplicitCheckout = Boolean(
    environment?.serverConfig?.providers.some((provider) => provider.driver === "meerkat"),
  );
  const key = projectRef ? scopedProjectKey(projectRef) : null;
  const [prepared, setPrepared] = useState<{
    key: string | null;
    draftId: DraftId | null;
    error: string | null;
  }>({ key, draftId: null, error: null });
  if (prepared.key !== key) {
    setPrepared({ key, draftId: null, error: null });
  }
  useEffect(() => {
    if (!environmentId || !projectId || !key || !ready || prepared.draftId || prepared.error)
      return;
    let cancelled = false;
    const ref = scopeProjectRef(environmentId, projectId);
    void openDraft(ref, {
      destination: "project-home",
      ...(hasExplicitCheckout
        ? { environmentSelection: "manual" as const, loadBalancedEnvironmentId: null }
        : {}),
    })
      .then((opened) => {
        if (cancelled || !opened) return;
        migrateProjectHomeDraft(ref, opened.draftId);
        setPrepared({ key, draftId: opened.draftId, error: null });
      })
      .catch((cause: unknown) => {
        if (!cancelled)
          setPrepared({
            key,
            draftId: null,
            error: cause instanceof Error ? cause.message : "Could not open the project draft.",
          });
      });
    return () => {
      cancelled = true;
    };
  }, [
    environmentId,
    hasExplicitCheckout,
    key,
    openDraft,
    prepared.draftId,
    prepared.error,
    projectId,
    ready,
  ]);
  return {
    draftId: prepared.key === key ? prepared.draftId : null,
    error: prepared.key === key ? prepared.error : null,
    retry: () => setPrepared({ key, draftId: null, error: null }),
  };
}
