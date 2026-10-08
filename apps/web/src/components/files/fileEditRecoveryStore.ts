import type { EnvironmentId } from "@t3tools/contracts";
import { randomUUID } from "~/lib/utils";

export interface FileEditRecoveryTarget {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
}

type RecoveryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

export interface FileEditRecoveryCopy {
  readonly key: string;
  readonly contents: string;
  readonly serialized: string;
}

export interface FileEditRecoveryWrite extends FileEditRecoveryCopy {
  readonly target: FileEditRecoveryTarget;
}

export interface FileEditRecoverySnapshot {
  readonly copies: readonly FileEditRecoveryCopy[];
  readonly current: { readonly contents: string; readonly persisted: boolean } | null;
  readonly readFailed: boolean;
  readonly removalFailed: boolean;
}

function browserStorage(): RecoveryStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function prefix(target: FileEditRecoveryTarget): string {
  return `t3code:file-edit-recovery:v1:${JSON.stringify([
    target.environmentId,
    target.cwd,
    target.relativePath,
  ])}:`;
}

function createWriterId(): string | null {
  try {
    return randomUUID();
  } catch {
    return null;
  }
}

export function createFileEditRecoveryStore(
  storage: () => RecoveryStorage | undefined = browserStorage,
  writerId: string | null = createWriterId(),
) {
  interface State {
    copies: Map<string, FileEditRecoveryCopy>;
    ownCopies: Map<string, FileEditRecoveryWrite>;
    current: FileEditRecoveryWrite | null;
    snapshot: FileEditRecoverySnapshot;
  }
  const states = new Map<string, State>();
  const listeners = new Set<() => void>();
  let revision = 0;

  function targetStorage(): RecoveryStorage {
    const result = storage();
    if (!result) throw new Error("Recovery storage unavailable");
    return result;
  }

  function update(state: State, changes: Partial<FileEditRecoverySnapshot> = {}): void {
    state.snapshot = {
      ...state.snapshot,
      ...changes,
      copies: [...state.copies.values()].filter(
        (copy) => !state.current || !state.ownCopies.has(copy.key),
      ),
    };
  }

  function read(target: FileEditRecoveryTarget, state: State): void {
    const copies = new Map<string, FileEditRecoveryCopy>();
    let unreadCopy = false;
    try {
      const store = targetStorage();
      const targetPrefix = prefix(target);
      for (let index = 0; index < store.length; index += 1) {
        const key = store.key(index);
        if (!key?.startsWith(targetPrefix)) continue;
        const serialized = store.getItem(key);
        if (serialized === null) continue;
        try {
          const value: unknown = JSON.parse(serialized);
          if (
            !value ||
            typeof value !== "object" ||
            !("version" in value) ||
            value.version !== 1 ||
            !("contents" in value) ||
            typeof value.contents !== "string"
          )
            throw new Error("Unread recovery copy");
          copies.set(key, { key, contents: value.contents, serialized });
        } catch {
          // Preserve malformed bytes, but do not let them hide later valid copies.
          unreadCopy = true;
        }
      }
      if (unreadCopy) throw new Error("Unread recovery copy");
      state.copies = copies;
      update(state, {
        readFailed: false,
        current: state.current
          ? { contents: state.current.contents, persisted: copies.has(state.current.key) }
          : null,
      });
    } catch {
      // A failed read is not proof that an older copy is absent.
      for (const [key, copy] of copies) state.copies.set(key, copy);
      update(state, { readFailed: true });
    }
  }

  function stateFor(target: FileEditRecoveryTarget): State {
    const key = prefix(target);
    let state = states.get(key);
    if (!state) {
      state = {
        copies: new Map(),
        ownCopies: new Map(),
        current: null,
        snapshot: { copies: [], current: null, readFailed: false, removalFailed: false },
      };
      states.set(key, state);
      read(target, state);
    }
    return state;
  }

  function remove(state: State, copy: FileEditRecoveryCopy): boolean {
    try {
      const store = targetStorage();
      const raw = store.getItem(copy.key);
      if (raw !== null && raw !== copy.serialized) return false;
      store.removeItem(copy.key);
      if (store.getItem(copy.key) !== null) return false;
      state.copies.delete(copy.key);
      state.ownCopies.delete(copy.key);
      return true;
    } catch {
      return false;
    }
  }

  function notify(): void {
    for (const listener of listeners) listener();
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot(target: FileEditRecoveryTarget): FileEditRecoverySnapshot {
      return stateFor(target).snapshot;
    },
    refresh(target: FileEditRecoveryTarget): void {
      read(target, stateFor(target));
      notify();
    },
    capture(target: FileEditRecoveryTarget, contents: string): FileEditRecoveryWrite {
      const state = stateFor(target);
      // Immutable generation keys make late confirmations and another window's
      // Discard incapable of deleting a newer edit (Storage has no compare-and-swap).
      const copy = {
        target,
        key: `${prefix(target)}${writerId ?? "unavailable"}:${++revision}`,
        contents,
        serialized: JSON.stringify({ version: 1, contents }),
      };
      state.current = copy;
      state.ownCopies.set(copy.key, copy);
      let persisted = false;
      let needsCleanup = false;
      let removalFailed = state.snapshot.removalFailed;
      try {
        if (writerId === null) throw new Error("Recovery identity unavailable");
        const store = targetStorage();
        store.setItem(copy.key, copy.serialized);
        needsCleanup = true;
        const stored = store.getItem(copy.key);
        persisted = stored === copy.serialized;
        if (stored === null) needsCleanup = false;
        if (persisted) {
          state.copies.set(copy.key, copy);
          removalFailed = false;
          // Keep the last confirmed recovery copy until its replacement is stored.
          for (const previous of state.ownCopies.values()) {
            if (previous !== copy && !remove(state, previous)) removalFailed = true;
          }
        }
      } catch {
        // The optimistic editor still owns this text; never interrupt its normal save.
      }
      // Failed setItem calls do not publish bytes. Do not retain every rejected
      // edit in memory, but keep writes whose readback is unavailable for cleanup.
      if (!needsCleanup) state.ownCopies.delete(copy.key);
      update(state, { current: { contents, persisted }, removalFailed });
      notify();
      return copy;
    },
    confirm(copy: FileEditRecoveryWrite): void {
      const state = stateFor(copy.target);
      if (state.current !== copy) return;
      state.current = null;
      let removalFailed = false;
      for (const previous of state.ownCopies.values()) {
        if (!remove(state, previous)) removalFailed = true;
      }
      update(state, { current: null, removalFailed });
      notify();
    },
    discard(target: FileEditRecoveryTarget, copy: FileEditRecoveryCopy): boolean {
      const state = stateFor(target);
      if (state.copies.get(copy.key) !== copy) return false;
      const removed = remove(state, copy);
      update(state, { removalFailed: !removed });
      notify();
      return removed;
    },
  };
}

export const fileEditRecoveryStore = createFileEditRecoveryStore();
