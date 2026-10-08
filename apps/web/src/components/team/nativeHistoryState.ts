import type { ConsoleFrame, MeerkatSavedTranscript } from "@t3tools/contracts";
import type { NativeMediaScope } from "./NativeAgentImages";
import type { AgentHistoryProgress } from "./agentHistory.logic";

export interface NativeHistoryPosition {
  rowId: string;
  offsetWithinRow: number;
  scrollOffset: number;
  atEnd: boolean;
}

/** Presentation-only session caches. Native pages retain their exact session/revision. */
export function createNativeHistoryCache<T>(maxEntries: number, maxBytes: number) {
  const entries = new Map<string, { value: T; bytes: number }>();
  let bytes = 0;
  return {
    get(key: string): T | undefined {
      const entry = entries.get(key);
      if (!entry) return undefined;
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },
    set(key: string, value: T) {
      const previous = entries.get(key);
      if (previous) bytes -= previous.bytes;
      entries.delete(key);
      // Bound serialized UTF-16 payload with a fixed per-entry allowance, not JS heap size.
      const size = JSON.stringify(value).length * 2 + 256;
      if (size > maxBytes) return;
      entries.set(key, { value, bytes: size });
      bytes += size;
      while (entries.size > maxEntries || bytes > maxBytes) {
        const oldest = entries.entries().next().value;
        if (!oldest) break;
        entries.delete(oldest[0]);
        bytes -= oldest[1].bytes;
      }
    },
  };
}

export function nativeHistoryIdentity(
  scope: NativeMediaScope,
  sessionId: string | null | undefined,
) {
  return JSON.stringify([
    scope.environmentId,
    scope.projectId,
    scope.instanceId,
    scope.agentRef ?? null,
    scope.threadId ?? null,
    sessionId ?? null,
  ]);
}

export const nativeTranscriptPages = createNativeHistoryCache<MeerkatSavedTranscript>(
  20,
  16 * 1024 * 1024,
);
export const nativeActivityPages = createNativeHistoryCache<{
  frames: readonly ConsoleFrame[];
  history: AgentHistoryProgress;
}>(20, 16 * 1024 * 1024);
export const nativeConversationPreferences = createNativeHistoryCache<{
  view: "saved" | "events";
  raw: boolean;
  savedRevision?: string;
}>(100, 128 * 1024);
// Scroll updates must stay independent of the size of the disclosure list.
const readingPositions = createNativeHistoryCache<NativeHistoryPosition>(100, 128 * 1024);
const readingDisclosures = createNativeHistoryCache<readonly string[]>(100, 896 * 1024);

export function readNativeHistoryPosition(identity: string) {
  return readingPositions.get(identity);
}

export function rememberNativeHistoryPosition(identity: string, position: NativeHistoryPosition) {
  readingPositions.set(identity, position);
}

/** Follow committed updates at the end; keep an older reading window on its exact revision. */
export function selectNativeTranscriptRevision(
  current: MeerkatSavedTranscript | undefined,
  latest: MeerkatSavedTranscript | undefined,
  position: NativeHistoryPosition | undefined,
) {
  if (!current) return latest;
  if (
    !latest ||
    current.sessionId !== latest.sessionId ||
    current.storeRevision === latest.storeRevision ||
    position?.atEnd === false
  )
    return current;
  return latest;
}

/** A newly opened revision starts at latest, while a mounted revision receives a scroll request. */
export function followNativeHistoryEnd(identity: string) {
  const position = readingPositions.get(identity);
  if (position) readingPositions.set(identity, { ...position, atEnd: true });
}

export function readNativeHistoryDisclosures(identity: string): ReadonlySet<string> {
  return new Set(readingDisclosures.get(identity));
}

export function rememberNativeHistoryDisclosures(identity: string, expanded: ReadonlySet<string>) {
  readingDisclosures.set(identity, [...expanded].slice(-1000));
}

/** Extend a contiguous window of one revision, or move to a distant search window. */
export function mergeNativeTranscriptWindows(
  current: MeerkatSavedTranscript,
  incoming: MeerkatSavedTranscript,
) {
  if (current.sessionId !== incoming.sessionId || current.storeRevision !== incoming.storeRevision)
    throw new Error("Cannot combine different saved conversation revisions.");
  const offsets = new Set(current.messages.map((message) => message.offset));
  const added = incoming.messages.filter((message) => !offsets.has(message.offset));
  if (!added.length) return current;
  const low = incoming.messages[0]?.offset ?? Infinity;
  const high = incoming.messages.at(-1)?.offset ?? -Infinity;
  const currentLow = current.messages[0]?.offset ?? Infinity;
  const currentHigh = current.messages.at(-1)?.offset ?? -Infinity;
  const joined = low <= currentHigh + 1 && currentLow <= high + 1;
  // A distant search hit replaces the current window. Never present a gap as
  // contiguous history or inherit an exhausted cursor from a separate window.
  if (!joined) return incoming;
  const messages = [...current.messages, ...added].sort(
    (left, right) => left.offset - right.offset,
  );
  const boundary = low < currentLow ? incoming : current;
  return { ...current, messages, exhausted: boundary.exhausted, nextBefore: boundary.nextBefore };
}
