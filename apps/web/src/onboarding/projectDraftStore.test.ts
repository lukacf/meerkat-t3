import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  createOnboardingProjectDraftStore,
  emptyOnboardingProjectDraft,
  safeOnboardingRemoteUrl,
} from "./projectDraftStore";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

describe("onboarding project drafts", () => {
  it("restores each computer's input and selects only a currently eligible computer", () => {
    const storage = memoryStorage();
    const store = createOnboardingProjectDraftStore(() => storage);
    const folder = { mode: "create" as const, path: "/home/me/new project", remoteUrl: "" };
    const clone = {
      mode: "clone" as const,
      path: "C:\\src\\repo",
      remoteUrl: "git@github.com:owner/repository.git",
    };
    expect(store.write(local, folder)).toBeNull();
    expect(store.write(remote, clone)).toBeNull();

    const reopened = createOnboardingProjectDraftStore(() => storage);
    expect(reopened.selectedEnvironment([local, remote])).toBe(remote);
    expect(reopened.selectedEnvironment([local])).toBe(local);
    expect(reopened.read(local).draft).toEqual(folder);
    expect(reopened.read(remote).draft).toEqual(clone);
    expect(reopened.read(EnvironmentId.make("new")).draft).toEqual(emptyOnboardingProjectDraft());
    expect(reopened.discard(remote)).toBeNull();
    expect(reopened.read(remote).draft).toEqual(emptyOnboardingProjectDraft());
    expect(reopened.read(local).draft).toEqual(folder);
  });

  it.each([
    "https://github.com/owner/repository.git",
    "http://git.internal/owner/repo",
    "git://github.com/owner/repo.git",
    "ssh://git@github.com:22/owner/repo.git",
    "git@github.com:owner/repo.git",
  ])("preserves the safe repository URL %s", (remoteUrl) => {
    expect(safeOnboardingRemoteUrl(remoteUrl)).toBe(remoteUrl);
  });

  it.each([
    "https://user:secret@github.com/owner/repo.git",
    "https://secret@github.com/owner/repo.git",
    "https://github.com/owner/repo.git?access_token=secret",
    "https://github.com/owner/repo.git#secret",
    "https://user:secret@",
    "ssh://git:secret@github.com/owner/repo.git",
    "git@github.com:owner/repo.git?secret",
    "git@github.com:owner/repo.git#secret",
  ])("never writes credentials or token-bearing URL fragments for %s", (remoteUrl) => {
    const storage = memoryStorage();
    const store = createOnboardingProjectDraftStore(() => storage);
    expect(store.write(local, { mode: "clone", path: "/repo", remoteUrl })).toBeNull();
    expect([...storage.values.values()].join(" ")).not.toContain("secret");
    expect(createOnboardingProjectDraftStore(() => storage).read(local).draft).toEqual({
      mode: "clone",
      path: "/repo",
      remoteUrl: "",
    });
  });

  it("keeps editing a known draft when storage later becomes unavailable", () => {
    const storage = memoryStorage();
    let available = true;
    const store = createOnboardingProjectDraftStore(() => (available ? storage : undefined));
    expect(store.read(local).error).toBeNull();
    available = false;
    expect(store.write(local, { mode: "open", path: "/repo", remoteUrl: "" })).toContain(
      "only in this view",
    );
    expect(store.read(local).draft.path).toBe("/repo");
    expect(store.read(local).error).toContain("only in this view");
    expect(store.discard(local)).toContain("could not be discarded");
  });

  it("blocks replacement writes after a failed read until retry restores the original attempt", () => {
    const storage = memoryStorage();
    const cloneAttempt = {
      projectId: ProjectId.make("original-clone"),
      title: "repo",
      createdAt: "2026-10-05T00:00:00.000Z",
      destinationPath: "/repo",
      remoteUrl: "https://github.com/owner/repo.git",
    };
    const draft = {
      mode: "clone" as const,
      path: cloneAttempt.destinationPath,
      remoteUrl: cloneAttempt.remoteUrl,
      cloneAttempt,
    };
    createOnboardingProjectDraftStore(() => storage).write(local, draft);
    const before = [...storage.values];
    let failRead = true;
    const reopened = createOnboardingProjectDraftStore(() => ({
      ...storage,
      getItem: (key) => {
        if (failRead) throw new Error("Storage temporarily unavailable");
        return storage.getItem(key);
      },
    }));
    expect(reopened.read(local).readFailed).toBe(true);
    failRead = false;
    expect(
      reopened.write(local, { mode: "create", path: "/replacement", remoteUrl: "" }),
    ).toContain("could not be read");
    expect([...storage.values]).toEqual(before);
    expect(reopened.read(local)).toEqual({ draft, error: null });
    expect(reopened.write(local, draft)).toBeNull();
  });

  it("keeps an unreadable draft protected until explicit discard is confirmed", () => {
    const storage = memoryStorage();
    const key = `t3code:onboarding-project-draft:v1:${JSON.stringify(local)}`;
    storage.setItem(key, "unreadable draft");
    let allowDiscard = false;
    const store = createOnboardingProjectDraftStore(() => ({
      ...storage,
      removeItem: (key) => {
        if (allowDiscard) storage.removeItem(key);
      },
    }));
    expect(store.read(local).readFailed).toBe(true);
    expect(store.discard(local)).toContain("could not be discarded");
    expect(store.write(local, emptyOnboardingProjectDraft())).toContain("could not be read");
    expect(storage.getItem(key)).toBe("unreadable draft");

    allowDiscard = true;
    expect(store.discard(local)).toBeNull();
    expect(store.read(local)).toEqual({ draft: emptyOnboardingProjectDraft(), error: null });
    expect(store.write(local, { mode: "create", path: "/replacement", remoteUrl: "" })).toBeNull();
  });

  it("does not treat an unconfirmed storage write or removal as saved", () => {
    const storage = memoryStorage();
    const store = createOnboardingProjectDraftStore(() => storage);
    store.write(local, { mode: "open", path: "/saved", remoteUrl: "" });
    const failing = createOnboardingProjectDraftStore(() => ({
      getItem: storage.getItem,
      setItem: () => undefined,
      removeItem: () => undefined,
    }));
    expect(failing.write(local, { mode: "open", path: "/unsaved", remoteUrl: "" })).not.toBeNull();
    expect(failing.discard(local)).not.toBeNull();
    expect(store.read(local).draft.path).toBe("/saved");
  });

  it("restores an attempted clone separately from a confirmed project", () => {
    const storage = memoryStorage();
    const cloneAttempt = {
      projectId: ProjectId.make("attempted-project"),
      title: "repo",
      createdAt: "2026-10-05T00:00:00.000Z",
      destinationPath: "/home/me/repo",
      remoteUrl: "https://github.com/owner/repo.git",
    };
    const draft = {
      mode: "clone" as const,
      path: cloneAttempt.destinationPath,
      remoteUrl: cloneAttempt.remoteUrl,
      cloneAttempt,
    };
    expect(createOnboardingProjectDraftStore(() => storage).write(local, draft)).toBeNull();
    const restored = createOnboardingProjectDraftStore(() => storage).read(local);
    expect(restored.error).toBeNull();
    expect(restored.draft.cloneAttempt).toEqual(cloneAttempt);
    expect(restored.draft.admittedProjectId).toBeUndefined();
  });

  it("keeps private clone input only in memory while retaining its durable recovery identity", () => {
    const storage = memoryStorage();
    const store = createOnboardingProjectDraftStore(() => storage);
    const remoteUrl = "https://user:secret@github.com/owner/repo.git";
    const cloneAttempt = {
      projectId: ProjectId.make("private-attempt"),
      title: "repo",
      createdAt: "2026-10-05T00:00:00.000Z",
      destinationPath: "/home/me/repo",
      remoteUrl,
    };
    expect(
      store.write(local, {
        mode: "clone",
        path: cloneAttempt.destinationPath,
        remoteUrl,
        cloneAttempt,
      }),
    ).toBeNull();
    expect(store.read(local).draft.cloneAttempt).toEqual(cloneAttempt);
    expect([...storage.values.values()].join(" ")).not.toContain("secret");
    const restored = createOnboardingProjectDraftStore(() => storage).read(local);
    expect(restored.draft.cloneAttempt).toEqual({ ...cloneAttempt, remoteUrl: "" });
    expect(restored.draft.remoteUrl).toBe("");
  });

  it("reports malformed attempts instead of silently restoring them as new clone requests", () => {
    const storage = memoryStorage();
    storage.setItem(
      `t3code:onboarding-project-draft:v1:${JSON.stringify(local)}`,
      JSON.stringify({
        version: 1,
        mode: "clone",
        path: "/repo",
        remoteUrl: "https://github.com/owner/repo.git",
        cloneAttempt: { projectId: "original", createdAt: "invalid" },
      }),
    );
    const restored = createOnboardingProjectDraftStore(() => storage).read(local);
    expect(restored.error).toContain("could not be read");
    expect(restored.draft.path).toBe("");
    expect(storage.values.size).toBe(1);
  });
});
