import type { ServerSettingsError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/** Await the registry's application of current, canonical server settings. */
export class ProviderInstanceSettingsReconciler extends Context.Service<
  ProviderInstanceSettingsReconciler,
  {
    readonly reconcileCurrentSettings: Effect.Effect<void, ServerSettingsError>;
  }
>()("t3/provider/Services/ProviderInstanceSettingsReconciler") {}
