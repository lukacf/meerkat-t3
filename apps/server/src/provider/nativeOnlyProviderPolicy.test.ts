import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { BUILT_IN_DRIVERS } from "./builtInDrivers.ts";
import { ensureNativeProviderSettingsIntent } from "../providerSettingsIntent.ts";

describe("Native-only runtime policy", () => {
  it("does not register donor runtimes for execution", () => {
    expect(BUILT_IN_DRIVERS.map((driver) => driver.driverKind)).toEqual(["meerkat"]);
  });
  it.effect(
    "rejects donor add/edit/reset while permitting explicit removal of saved configuration",
    () =>
      Effect.gen(function* () {
        const instanceId = ProviderInstanceId.make("saved-codex");
        const donor = ProviderDriverKind.make("codex");
        for (const intent of [
          { kind: "add" as const, instanceId, instance: { driver: donor, config: {} } },
          { kind: "edit" as const, instanceId, driver: donor, changes: { enabled: true } },
          { kind: "resetDefault" as const, driver: "codex" as const },
        ]) {
          const result = yield* Effect.result(ensureNativeProviderSettingsIntent(intent));
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure") expect(result.failure.reason).toBe("unsupported_driver");
        }
        yield* ensureNativeProviderSettingsIntent({ kind: "delete", instanceId });
        yield* ensureNativeProviderSettingsIntent({
          kind: "edit",
          instanceId: ProviderInstanceId.make("meerkat"),
          driver: ProviderDriverKind.make("meerkat"),
          changes: { enabled: true },
        });
      }),
  );
});
