import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type MeerkatSavedTranscript,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  createNativeHistoryCache,
  mergeNativeTranscriptWindows,
  nativeHistoryIdentity,
  readNativeHistoryDisclosures,
  readNativeHistoryPosition,
  rememberNativeHistoryDisclosures,
  rememberNativeHistoryPosition,
  selectNativeTranscriptRevision,
} from "./nativeHistoryState";
import { mergeSavedTranscriptPages } from "./nativeTranscript.logic";

const scope = {
  environmentId: EnvironmentId.make("host-a"),
  projectId: ProjectId.make("project-a"),
  instanceId: ProviderInstanceId.make("provider-a"),
  agentRef: "agent-a",
};
function page(start: number, end: number, revision = "7"): MeerkatSavedTranscript {
  return {
    sessionId: "session",
    storeRevision: revision,
    totalMessages: 1000,
    exhausted: start === 0,
    ...(start > 0 ? { nextBefore: start } : {}),
    messages: Array.from({ length: end - start + 1 }, (_, index) => ({
      offset: start + index,
      message: { role: "assistant", content: `Message ${start + index}` },
    })),
  };
}

describe("native reading state", () => {
  it("isolates environment, project, provider, agent and session even when names contain delimiters", () => {
    const original = nativeHistoryIdentity(scope, "session");
    for (const changed of [
      { ...scope, environmentId: EnvironmentId.make("host-b") },
      { ...scope, projectId: ProjectId.make("project-b") },
      { ...scope, instanceId: ProviderInstanceId.make("provider-b") },
      { ...scope, agentRef: "agent-b" },
    ])
      expect(nativeHistoryIdentity(changed, "session")).not.toBe(original);
    expect(nativeHistoryIdentity(scope, "new-session")).not.toBe(original);
    expect(nativeHistoryIdentity({ ...scope, agentRef: "a:b" }, "c")).not.toBe(
      nativeHistoryIdentity({ ...scope, agentRef: "a" }, "b:c"),
    );
  });

  it("retains a reading anchor and disclosures together without crossing snapshot revisions", () => {
    const key = `${nativeHistoryIdentity(scope, "session")}:saved:7`;
    const position = { rowId: "48", offsetWithinRow: 21, scrollOffset: 4800, atEnd: false };
    rememberNativeHistoryPosition(key, position);
    rememberNativeHistoryDisclosures(key, new Set(["48:2"]));
    expect(readNativeHistoryPosition(key)).toEqual(position);
    expect([...readNativeHistoryDisclosures(key)]).toEqual(["48:2"]);
    expect(
      readNativeHistoryPosition(`${nativeHistoryIdentity(scope, "session")}:saved:8`),
    ).toBeUndefined();
    rememberNativeHistoryPosition(key, { ...position, scrollOffset: 4850 });
    expect([...readNativeHistoryDisclosures(key)]).toEqual(["48:2"]);
  });

  it("follows a new committed revision at the end, including a cached conversation reopened after reconnect", () => {
    const current = page(900, 999);
    const latest = page(902, 1001, "16");
    const identity = `${nativeHistoryIdentity(scope, "following-session")}:saved:7`;
    const cache = createNativeHistoryCache<MeerkatSavedTranscript>(2, 1024 * 1024);
    cache.set(identity, current);
    rememberNativeHistoryPosition(identity, {
      rowId: "999",
      offsetWithinRow: 0,
      scrollOffset: 10000,
      atEnd: true,
    });
    expect(
      selectNativeTranscriptRevision(
        cache.get(identity),
        latest,
        readNativeHistoryPosition(identity),
      ),
    ).toBe(latest);
    expect(selectNativeTranscriptRevision(undefined, latest, undefined)).toBe(latest);
    expect(selectNativeTranscriptRevision(current, latest, undefined)).toBe(latest);
  });

  it("retains the exact older revision and page cursor while reading above the end", () => {
    const current = mergeSavedTranscriptPages(page(900, 999), page(800, 899));
    const latest = page(902, 1001, "16");
    const position = { rowId: "848", offsetWithinRow: 21, scrollOffset: 4800, atEnd: false };
    expect(selectNativeTranscriptRevision(current, latest, position)).toBe(current);
    expect(selectNativeTranscriptRevision(current, page(900, 999), position)).toBe(current);
    expect(selectNativeTranscriptRevision(current, undefined, position)).toBe(current);
    expect(
      selectNativeTranscriptRevision(current, { ...latest, sessionId: "replacement" }, undefined),
    ).toBe(current);
    expect(current.nextBefore).toBe(800);
  });

  it("bounds disclosure retention without losing the independent reading anchor", () => {
    const key = `${nativeHistoryIdentity(scope, "bounded-session")}:events`;
    const position = { rowId: "last", offsetWithinRow: 12, scrollOffset: 9600, atEnd: false };
    rememberNativeHistoryPosition(key, position);
    rememberNativeHistoryDisclosures(
      key,
      new Set(Array.from({ length: 1100 }, (_, index) => `row-${index}:output`)),
    );
    const disclosures = readNativeHistoryDisclosures(key);
    expect(disclosures.size).toBe(1000);
    expect(disclosures.has("row-0:output")).toBe(false);
    expect(disclosures.has("row-1099:output")).toBe(true);
    // An oversized presentation entry may be dropped, but it must not erase
    // the small reading position stored for the same conversation.
    rememberNativeHistoryDisclosures(key, new Set(["x".repeat(512 * 1024)]));
    expect(readNativeHistoryDisclosures(key).size).toBe(0);
    expect(readNativeHistoryPosition(key)).toEqual(position);
  });

  it("evicts least recently used data and enforces a separate payload budget", () => {
    const cache = createNativeHistoryCache<string>(2, 1000);
    cache.set("a", "a");
    cache.set("b", "b");
    expect(cache.get("a")).toBe("a");
    cache.set("c", "c");
    expect(cache.get("b")).toBeUndefined();
    cache.set("large", "x".repeat(200));
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("c")).toBe("c");
    cache.set("oversized", "x".repeat(1000));
    expect(cache.get("oversized")).toBeUndefined();
    expect(cache.get("large")).toHaveLength(200);
  });

  it("restores accumulated pages, accepts a new overlapping search window, and retains the oldest cursor", () => {
    const loaded = mergeSavedTranscriptPages(page(900, 999), page(800, 899));
    const merged = mergeNativeTranscriptWindows(loaded, page(750, 849));
    expect(merged.messages).toHaveLength(250);
    expect(new Set(merged.messages.map((entry) => entry.offset)).size).toBe(250);
    expect(merged.nextBefore).toBe(750);
    expect(mergeNativeTranscriptWindows(merged, page(900, 999))).toBe(merged);
  });

  it("never combines revisions or sessions and never presents a missing search interval as loaded", () => {
    expect(() => mergeNativeTranscriptWindows(page(900, 999), page(0, 99, "8"))).toThrow(
      "different saved conversation revisions",
    );
    expect(() =>
      mergeNativeTranscriptWindows(page(900, 999), { ...page(0, 99), sessionId: "replacement" }),
    ).toThrow();
    const distant = page(100, 199);
    expect(mergeNativeTranscriptWindows(page(900, 999), distant)).toBe(distant);
    const earliest = page(0, 99);
    const latest = page(900, 999);
    expect(mergeNativeTranscriptWindows(earliest, latest)).toBe(latest);
    expect(mergeNativeTranscriptWindows(earliest, latest).exhausted).toBe(false);
  });
});
