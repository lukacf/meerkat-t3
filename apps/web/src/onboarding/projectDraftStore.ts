import { ProjectId, type EnvironmentId } from "@t3tools/contracts";

export type OnboardingProjectCloneAttempt = {
  projectId: ProjectId;
  title: string;
  createdAt: string;
  destinationPath: string;
  remoteUrl: string;
};

export type OnboardingProjectDraft = {
  mode: "open" | "create" | "clone";
  path: string;
  remoteUrl: string;
  admittedProjectId?: ProjectId;
  cloneAttempt?: OnboardingProjectCloneAttempt;
};
type OnboardingProjectDraftState = {
  draft: OnboardingProjectDraft;
  error: string | null;
  readFailed?: true;
};
type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const PREFIX = "t3code:onboarding-project-draft:v1:";
const SELECTED_ENVIRONMENT_KEY = `${PREFIX}selected-environment`;
const keyFor = (environmentId: EnvironmentId) => `${PREFIX}${JSON.stringify(environmentId)}`;
const READ_ERROR = "Saved project setup could not be read on this device.";

export const emptyOnboardingProjectDraft = (): OnboardingProjectDraft => ({
  mode: "open",
  path: "",
  remoteUrl: "",
});

/** Only complete Git URLs without secrets are durable. Keep other input in the open form. */
export function safeOnboardingRemoteUrl(value: string): string {
  const trimmed = value.trim();
  if (/\s/.test(trimmed)) return "";
  // The conventional SSH account is a transport identity, not a saved credential.
  if (/^git@(?:[a-z0-9._-]+|\[[a-f0-9:]+\]):[^?#@]+$/i.test(trimmed)) return value;
  try {
    const url = new URL(trimmed);
    if (
      !["https:", "http:", "git:", "ssh:"].includes(url.protocol) ||
      !url.hostname ||
      !url.pathname.replace(/^\/+/, "") ||
      (url.username !== "" && !(url.protocol === "ssh:" && url.username === "git")) ||
      url.password ||
      url.search ||
      url.hash
    )
      return "";
    return value;
  } catch {
    return "";
  }
}

function browserStorage(): DraftStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function readCloneAttempt(value: unknown): OnboardingProjectCloneAttempt | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "object" ||
    value === null ||
    !("projectId" in value) ||
    typeof value.projectId !== "string" ||
    !value.projectId.trim() ||
    !("title" in value) ||
    typeof value.title !== "string" ||
    !("createdAt" in value) ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !("destinationPath" in value) ||
    typeof value.destinationPath !== "string" ||
    !value.destinationPath.trim() ||
    !("remoteUrl" in value) ||
    typeof value.remoteUrl !== "string"
  )
    throw new Error("Invalid saved clone attempt");
  return {
    projectId: ProjectId.make(value.projectId),
    title: value.title,
    createdAt: value.createdAt,
    destinationPath: value.destinationPath,
    remoteUrl: safeOnboardingRemoteUrl(value.remoteUrl),
  };
}

/** Local form state only. Reading a draft never starts a project operation. */
export function createOnboardingProjectDraftStore(
  storage: () => DraftStorage | undefined = browserStorage,
) {
  const liveDrafts = new Map<EnvironmentId, OnboardingProjectDraftState>();
  const unreadDrafts = new Set<EnvironmentId>();
  const target = () => {
    const result = storage();
    if (!result) throw new Error("Local storage unavailable");
    return result;
  };
  return {
    selectedEnvironment(environmentIds: readonly EnvironmentId[]) {
      try {
        const saved = target().getItem(SELECTED_ENVIRONMENT_KEY);
        return environmentIds.find((id) => id === saved) ?? environmentIds[0];
      } catch {
        return environmentIds[0];
      }
    },
    selectEnvironment(environmentId: EnvironmentId) {
      try {
        target().setItem(SELECTED_ENVIRONMENT_KEY, environmentId);
      } catch {
        // Draft writes report storage failures without blocking computer selection.
      }
    },
    read(environmentId: EnvironmentId | undefined): OnboardingProjectDraftState {
      const empty = emptyOnboardingProjectDraft();
      if (!environmentId) return { draft: empty, error: null };
      const live = liveDrafts.get(environmentId);
      if (live) return live;
      try {
        const raw = target().getItem(keyFor(environmentId));
        if (raw === null) {
          unreadDrafts.delete(environmentId);
          return { draft: empty, error: null };
        }
        const value: unknown = JSON.parse(raw);
        if (
          typeof value !== "object" ||
          value === null ||
          !("version" in value) ||
          value.version !== 1 ||
          !("mode" in value) ||
          (value.mode !== "open" && value.mode !== "create" && value.mode !== "clone") ||
          !("path" in value) ||
          typeof value.path !== "string" ||
          !("remoteUrl" in value) ||
          typeof value.remoteUrl !== "string" ||
          ("admittedProjectId" in value &&
            (typeof value.admittedProjectId !== "string" || !value.admittedProjectId.trim()))
        )
          throw new Error("Invalid saved project draft");
        const cloneAttempt = readCloneAttempt(
          "cloneAttempt" in value ? value.cloneAttempt : undefined,
        );
        if (cloneAttempt && (value.mode !== "clone" || "admittedProjectId" in value))
          throw new Error("Invalid saved clone attempt state");
        unreadDrafts.delete(environmentId);
        return {
          draft: {
            mode: value.mode,
            path: value.path,
            remoteUrl: safeOnboardingRemoteUrl(value.remoteUrl),
            ...("admittedProjectId" in value && typeof value.admittedProjectId === "string"
              ? { admittedProjectId: ProjectId.make(value.admittedProjectId) }
              : {}),
            ...(cloneAttempt ? { cloneAttempt } : {}),
          },
          error: null,
        };
      } catch {
        unreadDrafts.add(environmentId);
        return { draft: empty, error: READ_ERROR, readFailed: true };
      }
    },
    write(environmentId: EnvironmentId, draft: OnboardingProjectDraft) {
      // An unread draft may own an admitted clone. Only a successful read or
      // explicit discard can authorize replacing it with a different intent.
      if (unreadDrafts.has(environmentId)) return READ_ERROR;
      let error: string | null = null;
      try {
        const store = target();
        const key = keyFor(environmentId);
        const value = JSON.stringify({
          version: 1,
          mode: draft.mode,
          path: draft.path,
          remoteUrl: safeOnboardingRemoteUrl(draft.remoteUrl),
          ...(draft.admittedProjectId ? { admittedProjectId: draft.admittedProjectId } : {}),
          ...(draft.cloneAttempt
            ? {
                cloneAttempt: {
                  ...draft.cloneAttempt,
                  remoteUrl: safeOnboardingRemoteUrl(draft.cloneAttempt.remoteUrl),
                },
              }
            : {}),
        });
        store.setItem(key, value);
        if (store.getItem(key) !== value) throw new Error("Draft write was not confirmed");
        store.setItem(SELECTED_ENVIRONMENT_KEY, environmentId);
      } catch {
        error = "Project setup is only in this view. This device could not save your draft.";
      }
      liveDrafts.set(environmentId, { draft: { ...draft }, error });
      return error;
    },
    discard(environmentId: EnvironmentId) {
      try {
        const store = target();
        const key = keyFor(environmentId);
        store.removeItem(key);
        if (store.getItem(key) !== null) throw new Error("Draft removal was not confirmed");
        liveDrafts.delete(environmentId);
        unreadDrafts.delete(environmentId);
        return null;
      } catch {
        const error =
          "The saved project draft could not be discarded. Keep this view open and try again.";
        const live = liveDrafts.get(environmentId);
        if (live) liveDrafts.set(environmentId, { ...live, error });
        return error;
      }
    },
  };
}
