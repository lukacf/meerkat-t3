import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import { makeMeerkatUsageService } from "./MeerkatUsageService.ts";

const instanceId = ProviderInstanceId.make("native");
const complete = {
  observedAt: "2026-10-04T10:00:00.000Z",
  scope: "current-provider-storage",
  coverage: "complete",
  stores: 1,
  sessions: 3,
  totals: {
    inputTokens: 120,
    outputTokens: 12,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    reasoningTokens: null,
  },
  issues: [],
  exclusions: ["auxiliary-generation", "previous-provider-storage"],
};
const harness = (response: unknown = complete, changeOwner = false) => {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let reads = 0;
  const instance = {
    instanceId,
    enabled: true,
    meerkatTeam: { stateRoot: "/configured/provider" },
    meerkatControls: {
      request: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        return response;
      },
    },
  } as unknown as ProviderInstance;
  const layer = Layer.mock(ProviderInstanceRegistry)({
    getInstance: (id) =>
      Effect.sync(() => {
        reads += 1;
        return id !== instanceId
          ? undefined
          : changeOwner && reads > 1
            ? { ...instance }
            : instance;
      }),
  });
  return {
    calls,
    run: makeMeerkatUsageService.pipe(
      Effect.flatMap((service) => service.snapshot({ instanceId })),
      Effect.provide(layer),
    ),
  };
};

it.effect("uses only the configured provider storage and retains native snapshot totals", () =>
  Effect.gen(function* () {
    const { run, calls } = harness();
    const result = yield* run;
    expect(calls).toEqual([
      { method: "mobs.v1.usageSnapshot", params: { providerStateRoot: "/configured/provider" } },
    ]);
    expect(result.instanceId).toBe(instanceId);
    expect(result.totals?.inputTokens).toBe(120);
  }),
);

it.effect("keeps unavailable coverage unavailable without deriving partial totals", () =>
  Effect.gen(function* () {
    const { run } = harness({
      ...complete,
      coverage: "unavailable",
      totals: null,
      issues: [
        {
          code: "store-unavailable",
          store: "projects/project/mobkit/thread/runtime.sqlite",
          message: "Unreadable authority",
        },
      ],
    });
    const result = yield* run;
    expect(result.coverage).toBe("unavailable");
    expect(result.totals).toBeNull();
  }),
);

it.effect("rejects a snapshot after the configured provider was replaced", () =>
  Effect.gen(function* () {
    const error = yield* harness(complete, true).run.pipe(Effect.flip);
    expect(error.message).toContain("connection changed");
  }),
);

it.effect("rejects contradictory native coverage", () =>
  Effect.gen(function* () {
    const error = yield* harness({ ...complete, coverage: "unavailable" }).run.pipe(Effect.flip);
    expect(error._tag).toBe("MeerkatUsageError");
  }),
);
