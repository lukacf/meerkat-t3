import {
  MeerkatNativeUsageSnapshot,
  MeerkatUsageError,
  type MeerkatUsageInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";

const fail = (cause: unknown) =>
  new MeerkatUsageError({
    message: cause instanceof Error ? cause.message : String(cause),
  });

/** The authenticated environment chooses the provider; clients never supply storage paths. */
export const makeMeerkatUsageService = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry;
  return {
    snapshot: Effect.fn("MeerkatUsage.snapshot")(function* (input: MeerkatUsageInput) {
      const instance = yield* registry.getInstance(input.instanceId);
      if (!instance?.enabled || !instance.meerkatControls || !instance.meerkatTeam) {
        return yield* fail("Connect this Meerkat provider to read its recorded lifetime usage.");
      }
      const snapshot = yield* Effect.tryPromise({
        try: () =>
          instance.meerkatControls!.request("mobs.v1.usageSnapshot", {
            providerStateRoot: instance.meerkatTeam!.stateRoot,
          }),
        catch: fail,
      }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(MeerkatNativeUsageSnapshot)),
        Effect.mapError(fail),
      );
      if ((yield* registry.getInstance(input.instanceId)) !== instance) {
        return yield* fail("The Meerkat connection changed while reading usage. Refresh to retry.");
      }
      return { instanceId: input.instanceId, ...snapshot };
    }),
  };
});
