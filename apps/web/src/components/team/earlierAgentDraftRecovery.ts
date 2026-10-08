import { MeerkatImageRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { AgentDraftScope } from "./agentDraftIdentity";
import { readAgentConversationDrafts, type SendAttempt } from "./agentConversationDraftStore";
import { readAgentUnsentQueue } from "./agentUnsentQueueStore";

type RecoveryStorage = Pick<Storage, "getItem" | "key" | "length">;
export type EarlierDraftStorage = { local?: RecoveryStorage; session?: RecoveryStorage };
export type EarlierAgentDraft = {
  id: string;
  source: "local" | "session";
  key: string;
  label: string;
  kind: "draft" | "queue" | "composer" | "images";
  text: string;
  attempts: ReadonlyArray<SendAttempt>;
  saved: unknown;
  imagePreview?: { agentRef: string; images: ReadonlyArray<MeerkatImageRef> };
};

const IMAGE_PREFIX = "t3code:meerkat-image-drafts:v1:";
const SESSION_IMAGE_PREFIX = "meerkat-image-draft:";
const decodeImages = Schema.decodeUnknownSync(Schema.Array(MeerkatImageRef));

function scopedParts(key: string, scope: AgentDraftScope, length: number): string[] | null {
  try {
    const parts: unknown = JSON.parse(key);
    return Array.isArray(parts) &&
      parts.length === length &&
      parts.every((part) => typeof part === "string") &&
      parts[0] === scope.environmentId &&
      parts[1] === scope.projectId &&
      parts[2] === scope.instanceId
      ? parts
      : null;
  } catch {
    return null;
  }
}

function legacyAliasLabel(key: string, scope: AgentDraftScope): string | null {
  const parts = scopedParts(key, scope, 5);
  return parts ? `${parts[4]} (${parts[3]})` : null;
}

function composerLabel(key: string, scope: AgentDraftScope): string | null {
  if (key.startsWith("native-agent:"))
    return legacyAliasLabel(key.slice("native-agent:".length), scope);
  if (key.startsWith("native-project-agent:")) {
    const parts = scopedParts(key.slice("native-project-agent:".length), scope, 4);
    return parts ? `Project agent ${parts[3]}` : null;
  }
  return null;
}

function imageLabel(key: string, scope: AgentDraftScope): string | null {
  if (key.startsWith(IMAGE_PREFIX)) {
    const parts: unknown = JSON.parse(key.slice(IMAGE_PREFIX.length));
    if (
      !Array.isArray(parts) ||
      parts.length !== 4 ||
      parts[0] !== scope.environmentId ||
      parts[1] !== scope.projectId ||
      parts[2] !== scope.instanceId ||
      !Array.isArray(parts[3])
    )
      return null;
    const target = parts[3];
    if (target[0] === "agent" && typeof target[1] === "string")
      return legacyAliasLabel(target[1], scope);
    if (target[0] === "scope" && target[1] === null && typeof target[2] === "string")
      return `Saved agent session ${target[2]}`;
  }
  if (key.startsWith(SESSION_IMAGE_PREFIX)) {
    const target: unknown = JSON.parse(key.slice(SESSION_IMAGE_PREFIX.length));
    if (
      target &&
      typeof target === "object" &&
      Reflect.get(target, "environmentId") === scope.environmentId &&
      Reflect.get(target, "projectId") === scope.projectId &&
      Reflect.get(target, "instanceId") === scope.instanceId &&
      !Reflect.get(target, "threadId") &&
      typeof Reflect.get(target, "agentRef") === "string"
    )
      return `Saved agent session ${String(Reflect.get(target, "agentRef"))}`;
  }
  return null;
}

function originalImageAgentRef(key: string): string | undefined {
  if (key.startsWith(SESSION_IMAGE_PREFIX)) {
    const target: unknown = JSON.parse(key.slice(SESSION_IMAGE_PREFIX.length));
    const ref: unknown =
      target && typeof target === "object" ? Reflect.get(target, "agentRef") : undefined;
    return typeof ref === "string" && ref ? ref : undefined;
  }
  const parts: unknown = JSON.parse(key.slice(IMAGE_PREFIX.length));
  if (!Array.isArray(parts) || !Array.isArray(parts[3])) return undefined;
  const target = parts[3];
  return target[0] === "scope" && target[1] === null && typeof target[2] === "string" && target[2]
    ? target[2]
    : undefined;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid saved draft record");
  return value as Record<string, unknown>;
}

/** Older keys have ambiguous ownership. Recovery reads never promote or delete their contents. */
export function readEarlierAgentDrafts(scope: AgentDraftScope, storages: EarlierDraftStorage) {
  const entries: EarlierAgentDraft[] = [];
  const errors: string[] = [];
  for (const source of ["local", "session"] as const) {
    const storage = storages[source];
    if (!storage) continue;
    const add = (
      key: string,
      label: string,
      kind: EarlierAgentDraft["kind"],
      text: string,
      saved: unknown,
      attempts: ReadonlyArray<SendAttempt> = [],
    ) => {
      entries.push({
        id: JSON.stringify([source, kind, key]),
        source,
        key,
        label,
        kind,
        text,
        attempts: structuredClone(attempts),
        saved: structuredClone(saved),
      });
    };
    const read = (label: string, action: () => void) => {
      try {
        action();
      } catch {
        errors.push(
          `${label} could not be read from ${source === "local" ? "saved storage" : "this window"}. The original data is unchanged.`,
        );
      }
    };
    read("Earlier message drafts", () => {
      for (const [key, draft] of Object.entries(readAgentConversationDrafts(storage))) {
        const label = legacyAliasLabel(key, scope);
        if (
          label &&
          (draft.text || draft.attempts.length || draft.modelSelection || draft.mode !== "queue")
        )
          add(key, label, "draft", draft.text, draft, draft.attempts);
      }
    });
    read("Earlier queued messages", () => {
      for (const [key, rows] of Object.entries(readAgentUnsentQueue(storage))) {
        const label = legacyAliasLabel(key, scope);
        if (label && rows.length)
          add(
            key,
            label,
            "queue",
            rows.map((row) => row.text || "[Image message]").join("\n\n"),
            rows,
          );
      }
    });
    read("Earlier composer drafts", () => {
      const raw = storage.getItem("t3code:composer-drafts:v1");
      if (!raw) return;
      const state = record(record(JSON.parse(raw)).state);
      for (const [key, saved] of Object.entries(record(state.draftsByThreadKey ?? {}))) {
        const label = composerLabel(key, scope);
        if (!label) continue;
        const draft = record(saved);
        add(key, label, "composer", typeof draft.prompt === "string" ? draft.prompt : "", saved);
      }
    });
    read("Earlier image references", () => {
      for (let index = 0; index < storage.length; index++) {
        const key = storage.key(index);
        if (!key || (!key.startsWith(IMAGE_PREFIX) && !key.startsWith(SESSION_IMAGE_PREFIX)))
          continue;
        const label = imageLabel(key, scope);
        if (!label) continue;
        const images = decodeImages(JSON.parse(storage.getItem(key) ?? "[]"));
        if (images.length) {
          add(
            key,
            label,
            "images",
            `${images.length} saved image ${images.length === 1 ? "reference" : "references"}`,
            images,
          );
          const agentRef = originalImageAgentRef(key);
          if (agentRef) entries[entries.length - 1]!.imagePreview = { agentRef, images };
        }
      }
    });
  }
  return { entries, errors };
}

/** Re-read the original row so a stale recovery view cannot invent or retarget a request. */
export function readEarlierAgentSendAttempt(
  scope: AgentDraftScope,
  storages: EarlierDraftStorage,
  entry: Pick<EarlierAgentDraft, "kind" | "key" | "source">,
  requestId: string,
): SendAttempt | undefined {
  if (entry.kind !== "draft" || !legacyAliasLabel(entry.key, scope)) return undefined;
  const attempt = readAgentConversationDrafts(storages[entry.source])[entry.key]?.attempts.find(
    (saved) => saved.requestId === requestId,
  );
  return attempt ? structuredClone(attempt) : undefined;
}

export function earlierAgentDeliveryInput(scope: AgentDraftScope, attempt: SendAttempt) {
  if (!attempt.agentRef) return null;
  return {
    environmentId: scope.environmentId,
    input: {
      projectId: scope.projectId,
      instanceId: scope.instanceId,
      agentRef: attempt.agentRef,
      requestId: attempt.requestId,
      text: attempt.text,
      handlingMode: attempt.mode,
      ...(attempt.context ? { context: attempt.context } : {}),
      ...(attempt.images?.length ? { images: attempt.images } : {}),
      ...(attempt.modelSelection ? { modelSelection: attempt.modelSelection } : {}),
    },
  };
}
