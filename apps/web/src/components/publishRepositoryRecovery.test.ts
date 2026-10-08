import { describe, expect, it } from "vite-plus/test";
import type {
  SourceControlPublishPendingResult,
  SourceControlPublishRepositoryResult,
} from "@t3tools/contracts";
import { createPublishRepositoryRecoveryStore } from "./publishRepositoryRecovery";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    get length() {
      return values.size;
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}
const scope = { environmentId: "server-a", cwd: "/workspace" };
function pending(name = "first"): SourceControlPublishPendingResult {
  const repository = {
    provider: "github" as const,
    nameWithOwner: `owner/${name}`,
    url: `https://github.com/owner/${name}`,
    sshUrl: `git@github.com:owner/${name}.git`,
  };
  return {
    status: "push_pending",
    repository,
    remoteName: "origin",
    remoteUrl: repository.url,
    resume: { cwd: scope.cwd, repository, remoteName: "origin", remoteUrl: repository.url },
    detail: "The push did not finish.",
  };
}
function finished(record: SourceControlPublishPendingResult): SourceControlPublishRepositoryResult {
  return {
    status: "pushed",
    repository: record.repository,
    remoteName: record.remoteName,
    remoteUrl: record.remoteUrl,
    branch: "main",
  };
}

describe("known-created publish recovery", () => {
  it("publishes stable current snapshots to mounted consumers after completion and storage refresh", () => {
    const storage = memoryStorage();
    const store = createPublishRepositoryRecoveryStore(() => storage);
    const snapshot = store.snapshotReader(scope);
    const otherScope = store.snapshotReader({ ...scope, cwd: "/other-worktree" });
    const initial = snapshot();
    const observed: number[] = [];
    const unsubscribe = store.subscribe(() => observed.push(snapshot().pending.length));

    expect(snapshot()).toBe(initial);
    store.record(scope, pending("one"));
    expect(snapshot().pending).toEqual([pending("one")]);
    expect(snapshot()).toBe(snapshot());
    expect(otherScope().pending).toEqual([]);

    store.record(scope, finished(pending("one")));
    expect(snapshot().pending).toEqual([]);
    expect(snapshot()).toBe(snapshot());
    expect(observed).toEqual([1, 0]);

    const otherWindow = createPublishRepositoryRecoveryStore(() => storage);
    otherWindow.record(scope, pending("two"));
    store.refresh();
    expect(snapshot().pending).toEqual([pending("two")]);
    expect(observed).toEqual([1, 0, 1]);
    unsubscribe();
  });

  it("survives reopening only in its exact environment and checkout", () => {
    const storage = memoryStorage();
    const first = createPublishRepositoryRecoveryStore(() => storage);
    first.record(scope, pending());
    const reopened = createPublishRepositoryRecoveryStore(() => storage);
    expect(reopened.read(scope).pending).toEqual([pending()]);
    expect(reopened.read({ ...scope, environmentId: "server-b" }).pending).toEqual([]);
    expect(reopened.read({ ...scope, cwd: "/other-worktree" }).pending).toEqual([]);
  });

  it("preserves two overlapping windows' repositories and clears only the completed one", () => {
    const storage = memoryStorage();
    const firstWindow = createPublishRepositoryRecoveryStore(() => storage);
    const secondWindow = createPublishRepositoryRecoveryStore(() => storage);
    expect(firstWindow.read(scope).pending).toEqual([]);
    expect(secondWindow.read(scope).pending).toEqual([]);
    firstWindow.record(scope, pending("one"));
    secondWindow.record(scope, pending("two"));
    expect(firstWindow.read(scope).pending).toEqual([pending("one"), pending("two")]);
    firstWindow.record(scope, finished(pending("one")));
    expect(secondWindow.read(scope).pending).toEqual([pending("two")]);
    const restarted = createPublishRepositoryRecoveryStore(() => storage);
    expect(restarted.read(scope).pending).toEqual([pending("two")]);
  });

  it("reports unreadable or corrupt records without deleting them or treating storage as empty", () => {
    const storage = memoryStorage();
    const store = createPublishRepositoryRecoveryStore(() => storage);
    store.record(scope, pending());
    const key = storage.key(0)!;
    storage.setItem(key, "broken saved bytes");
    expect(store.read(scope)).toMatchObject({
      readable: false,
      error: expect.stringContaining("could not be read"),
    });
    expect(storage.getItem(key)).toBe("broken saved bytes");
    const unavailable = createPublishRepositoryRecoveryStore(() => {
      throw new Error("No storage");
    });
    expect(unavailable.read(scope).readable).toBe(false);
  });

  it("rejects a saved record whose checkout no longer matches its scoped key", () => {
    const storage = memoryStorage();
    const store = createPublishRepositoryRecoveryStore(() => storage);
    store.record(scope, pending());
    const key = storage.key(0)!;
    storage.setItem(
      key,
      JSON.stringify({ ...pending(), resume: { ...pending().resume, cwd: "/other-worktree" } }),
    );
    expect(store.read(scope)).toMatchObject({ pending: [], readable: false });
  });

  it("keeps a failed persistence result visible and saves the same target when storage recovers", () => {
    const storage = memoryStorage();
    let writable = false;
    const store = createPublishRepositoryRecoveryStore(() => ({
      ...storage,
      get length() {
        return storage.length;
      },
      setItem: (key, value) => {
        if (!writable) throw new Error("Quota full");
        storage.setItem(key, value);
      },
    }));
    store.record(scope, pending());
    expect(store.read(scope)).toMatchObject({
      pending: [pending()],
      error: expect.stringContaining("could not be saved"),
    });
    expect(storage.length).toBe(0);
    writable = true;
    store.record(scope, pending());
    expect(store.read(scope).error).toBeNull();
    expect(createPublishRepositoryRecoveryStore(() => storage).read(scope).pending).toEqual([
      pending(),
    ]);
  });

  it("reports failed cleanup without clearing a different pending repository", () => {
    const storage = memoryStorage();
    let removable = true;
    const store = createPublishRepositoryRecoveryStore(() => ({
      ...storage,
      get length() {
        return storage.length;
      },
      removeItem: (key) => {
        if (!removable) throw new Error("Storage is read-only");
        storage.removeItem(key);
      },
    }));
    store.record(scope, pending("one"));
    store.record(scope, pending("two"));
    removable = false;
    store.record(scope, finished(pending("one")));
    expect(store.read(scope)).toMatchObject({
      pending: [pending("two")],
      error: expect.stringContaining("could not be cleared"),
    });
    expect(createPublishRepositoryRecoveryStore(() => storage).read(scope).pending).toEqual([
      pending("one"),
      pending("two"),
    ]);
  });
});
