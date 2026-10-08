import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { MeerkatNativeUsageSnapshot } from "./meerkatUsage.ts";

const decode = Schema.decodeUnknownSync(MeerkatNativeUsageSnapshot);
const complete = {
  observedAt: "2026-10-04T10:00:00.000Z",
  scope: "current-provider-storage",
  coverage: "complete",
  stores: 2,
  sessions: 4,
  totals: {
    inputTokens: 200,
    outputTokens: 20,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    reasoningTokens: null,
  },
  issues: [],
  exclusions: ["auxiliary-generation", "previous-provider-storage"],
};

describe("native lifetime usage coverage", () => {
  it("retains explicitly unknown cache and reasoning measurements", () => {
    expect(decode(complete).totals?.cacheReadTokens).toBeNull();
  });
  it("rejects a total presented with unavailable coverage", () => {
    expect(() =>
      decode({
        ...complete,
        coverage: "unavailable",
        issues: [{ code: "store-unavailable", store: "store", message: "Unreadable" }],
      }),
    ).toThrow();
  });
  it("requires an explanation for missing totals", () => {
    expect(() => decode({ ...complete, coverage: "unavailable", totals: null })).toThrow();
    expect(
      decode({
        ...complete,
        coverage: "unavailable",
        totals: null,
        issues: [{ code: "storage-unavailable", store: null, message: "Unreadable" }],
      }).totals,
    ).toBeNull();
  });
  it("cannot claim complete coverage while reporting an omitted store", () => {
    expect(() =>
      decode({
        ...complete,
        issues: [{ code: "store-unavailable", store: "store", message: "Unreadable" }],
      }),
    ).toThrow();
  });
});
