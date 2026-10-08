import { MeerkatImageRef, type EnvironmentId, type MeerkatMediaTarget } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { createStore } from "zustand/vanilla";
import { writeAgentDraftStorage, type AgentDraftStorage } from "./agentDraftStorage";

const decodeImages = Schema.decodeUnknownSync(Schema.Array(MeerkatImageRef));
const SAVE_ERROR = "These images could not be saved for restart. Free local storage and try again.";
const READ_ERROR = "Saved images could not be read. Retry loading them before sending new work.";
type ImageChange = (images: ReadonlyArray<MeerkatImageRef>) => ReadonlyArray<MeerkatImageRef>;
type ImageDraftStorage = AgentDraftStorage | (() => AgentDraftStorage | undefined);
const resolveStorage = (storage: ImageDraftStorage | undefined) =>
  typeof storage === "function" ? storage() : storage;
const uniqueImages = (images: ReadonlyArray<MeerkatImageRef>) => [
  ...new Map(images.map((image) => [image.blob_id, image])).values(),
];

export function nativeImageDraftStorageKey(
  scope: MeerkatMediaTarget & { environmentId: EnvironmentId },
  draftKey?: string,
): string {
  return `t3code:meerkat-image-drafts:v1:${JSON.stringify([
    scope.environmentId,
    scope.projectId,
    scope.instanceId,
    draftKey ? ["agent", draftKey] : ["scope", scope.threadId ?? null, scope.agentRef ?? null],
  ])}`;
}

type NativeImageDraft = {
  images: ReadonlyArray<MeerkatImageRef>;
  persistenceError: string | null;
  uploadError: string | null;
  uploading: boolean;
  readFailed: boolean;
  retryRead: () => boolean;
  readForSend: () => ReadonlyArray<MeerkatImageRef> | null;
  updateImages: (change: ImageChange, retainOnReadFailure?: boolean) => boolean;
};

/** Only native blob references live here. The native media store owns the image bytes. */
export function createNativeImageDraftStore(
  storageKey: string,
  legacyKey: string,
  storage?: ImageDraftStorage,
  legacyStorage?: ImageDraftStorage,
) {
  let pendingChanges: ImageChange[] = [];
  let legacyPreserved = false;
  const readSaved = () => {
    const durable = resolveStorage(storage);
    if (!durable) throw new Error("Image draft storage is unavailable");
    const current = durable.getItem(storageKey);
    const session = current == null ? resolveStorage(legacyStorage) : undefined;
    if (current == null && legacyStorage && !session)
      throw new Error("Legacy image draft storage is unavailable");
    const legacy = session?.getItem(legacyKey);
    let images = decodeImages(JSON.parse(current ?? legacy ?? "[]"));
    for (const pending of pendingChanges) images = pending(images);
    return { durable, session, legacy, images };
  };
  const store = createStore<NativeImageDraft>((set, get) => ({
    images: [],
    persistenceError: null,
    uploadError: null,
    uploading: false,
    readFailed: true,
    retryRead: () => {
      try {
        const { durable, session, legacy, images } = readSaved();
        if (legacy != null) {
          if (writeAgentDraftStorage(durable, storageKey, images)) {
            pendingChanges = [];
            legacyPreserved = false;
            try {
              if (session?.removeItem) session.removeItem(legacyKey);
              else session?.setItem(legacyKey, "[]");
            } catch {
              // Even an empty durable row prevents the old attachment list from returning.
            }
          } else if (!legacyPreserved) {
            pendingChanges.push((current) => uniqueImages([...current, ...images]));
            legacyPreserved = true;
          }
        }
        set({
          images,
          readFailed: false,
          persistenceError: pendingChanges.length ? SAVE_ERROR : null,
        });
        return true;
      } catch {
        set({ readFailed: true, persistenceError: READ_ERROR });
        return false;
      }
    },
    readForSend: () => {
      // A failed read needs an explicit retry. Fresh payloads also recheck storage
      // so a later read failure or another view's edits cannot send stale refs.
      if (get().readFailed || !get().retryRead()) return null;
      return structuredClone(get().images);
    },
    updateImages: (change, retainOnReadFailure = false) => {
      if (get().readFailed && !retainOnReadFailure) return false;
      let current;
      try {
        if (get().readFailed) throw new Error("Image draft read requires recovery");
        current = readSaved();
      } catch {
        // An upload may have completed since the last successful read. Keep its
        // refs in memory, but never admit them as a complete attachment list.
        if (retainOnReadFailure) pendingChanges.push(change);
        set({
          ...(retainOnReadFailure
            ? { images: structuredClone(uniqueImages(change(get().images))) }
            : {}),
          readFailed: true,
          persistenceError: READ_ERROR,
        });
        return false;
      }
      const next = structuredClone(uniqueImages(change(current.images)));
      const saved = writeAgentDraftStorage(current.durable, storageKey, next);
      if (saved) {
        pendingChanges = [];
        legacyPreserved = false;
      } else pendingChanges.push(change);
      set({
        images: next,
        persistenceError: saved ? null : SAVE_ERROR,
      });
      return saved;
    },
  }));
  store.getState().retryRead();
  return store;
}
