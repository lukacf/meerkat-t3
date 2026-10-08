export type AgentDraftStorage = Pick<Storage, "getItem" | "setItem"> &
  Partial<Pick<Storage, "removeItem">>;

export function browserAgentDraftStorage(
  kind: "localStorage" | "sessionStorage",
): AgentDraftStorage | undefined {
  try {
    return globalThis[kind];
  } catch {
    return undefined;
  }
}

export function writeAgentDraftStorage(
  storage: AgentDraftStorage | undefined,
  key: string,
  value: unknown,
): boolean {
  if (!storage) return false;
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return false;
    storage.setItem(key, serialized);
    return storage.getItem(key) === serialized;
  } catch {
    return false;
  }
}

/** Durable target rows win over a stale session copy, including acknowledged empty rows. */
export function migrateAgentDraftStorage<T>(
  storage: AgentDraftStorage | undefined,
  legacyStorage: AgentDraftStorage | undefined,
  key: string,
  read: (storage: AgentDraftStorage | undefined) => Record<string, T>,
): Record<string, T> {
  const current = read(storage);
  const legacy = read(legacyStorage);
  if (!Object.keys(legacy).length) return current;
  const merged = { ...legacy, ...current };
  if (writeAgentDraftStorage(storage, key, merged)) {
    try {
      if (legacyStorage?.removeItem) legacyStorage.removeItem(key);
      else legacyStorage?.setItem(key, "{}");
    } catch {
      // The durable rows prevent a stale session copy from reviving acknowledged sends.
    }
  }
  return merged;
}
