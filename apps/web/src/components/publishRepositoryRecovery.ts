import {
  SourceControlPublishPendingResult,
  type SourceControlPublishRepositoryResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useCallback, useMemo, useSyncExternalStore } from "react";

interface PublishScope {
  readonly environmentId: string | null;
  readonly cwd: string;
}
type RecoveryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;
const decode = Schema.decodeSync(Schema.fromJsonString(SourceControlPublishPendingResult));
const encode = Schema.encodeSync(Schema.fromJsonString(SourceControlPublishPendingResult));
const scopePrefix = (scope: PublishScope) =>
  `t3code:publish-recovery:v1:${JSON.stringify([scope.environmentId, scope.cwd])}:`;
function recoveryKey(scope: PublishScope, result: SourceControlPublishRepositoryResult) {
  return (
    scopePrefix(scope) +
    JSON.stringify([
      result.repository.provider,
      result.repository.nameWithOwner,
      result.repository.url,
      result.repository.sshUrl,
      result.remoteName,
      result.remoteUrl,
    ])
  );
}

export function createPublishRepositoryRecoveryStore(storage: () => RecoveryStorage) {
  const unsaved = new Map<
    string,
    { result: SourceControlPublishPendingResult | null; error: string }
  >();
  const listeners = new Set<() => void>();
  let revision = 0;
  const notify = () => {
    revision += 1;
    for (const listener of listeners) listener();
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key.startsWith("t3code:publish-recovery:v1:")) notify();
  };
  const read = (scope: PublishScope) => {
    const records = new Map<string, SourceControlPublishPendingResult>();
    const prefix = scopePrefix(scope);
    let readable = true;
    let error: string | null = null;
    try {
      const source = storage();
      for (let index = 0; index < source.length; index += 1) {
        const key = source.key(index);
        if (!key?.startsWith(prefix)) continue;
        const raw = source.getItem(key);
        if (raw === null) continue;
        const record = decode(raw);
        if (record.resume.cwd !== scope.cwd || recoveryKey(scope, record) !== key) {
          throw new Error("Publish recovery scope mismatch");
        }
        records.set(key, record);
      }
    } catch {
      readable = false;
      error =
        "Saved publishing progress could not be read on this device. Restore access to browser storage and reopen this workspace before creating another repository.";
    }
    for (const [key, entry] of unsaved) {
      if (!key.startsWith(prefix)) continue;
      if (entry.result) records.set(key, entry.result);
      else records.delete(key);
      error ??= entry.error;
    }
    return { pending: [...records.values()], readable, error };
  };
  return {
    subscribe(listener: () => void) {
      if (listeners.size === 0 && typeof window !== "undefined")
        window.addEventListener("storage", onStorage);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && typeof window !== "undefined")
          window.removeEventListener("storage", onStorage);
      };
    },
    snapshotReader(scope: PublishScope) {
      let snapshotRevision = revision;
      let snapshot = read(scope);
      return () => {
        if (snapshotRevision !== revision) {
          snapshot = read(scope);
          snapshotRevision = revision;
        }
        return snapshot;
      };
    },
    refresh: notify,
    read,
    record(scope: PublishScope, result: SourceControlPublishRepositoryResult) {
      const pending = "resume" in result ? result : null;
      if (pending && pending.resume.cwd !== scope.cwd) return;
      const key = recoveryKey(scope, result);
      try {
        const target = storage();
        if (pending) {
          const value = encode(pending);
          target.setItem(key, value);
          if (target.getItem(key) !== value)
            throw new Error("Publish recovery write was not retained");
        } else {
          target.removeItem(key);
          if (target.getItem(key) !== null) throw new Error("Publish recovery was not removed");
        }
        unsaved.delete(key);
      } catch {
        unsaved.set(key, {
          result: pending,
          error: pending
            ? "This recovery could not be saved on this device. Keep this workspace open until publishing finishes, or copy its repository and remote details."
            : "Publishing finished, but its saved recovery could not be cleared. A later Retry push will reuse the same repository.",
        });
      }
      notify();
    },
  };
}

const store = createPublishRepositoryRecoveryStore(() => window.localStorage);

export function usePublishRepositoryRecovery(scope: PublishScope) {
  const { environmentId, cwd } = scope;
  const getSnapshot = useMemo(
    () => store.snapshotReader({ environmentId, cwd }),
    [environmentId, cwd],
  );
  const state = useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
  const record = useCallback(
    (result: SourceControlPublishRepositoryResult) => {
      store.record({ environmentId, cwd }, result);
    },
    [environmentId, cwd],
  );
  const canCreate = useCallback(() => {
    if (environmentId === null || cwd.length === 0) return false;
    const latest = store.read({ environmentId, cwd });
    store.refresh();
    return latest.readable && latest.error === null && latest.pending.length === 0;
  }, [environmentId, cwd]);
  return { ...state, record, canCreate };
}
