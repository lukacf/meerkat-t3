/**
 * ProviderInstanceRegistryMutator — internal handle used by the hydration
 * layer to reconcile the live registry with a fresh
 * `ProviderInstanceConfigMap`.
 *
 * Kept separate from the public `ProviderInstanceRegistry` service tag so
 * downstream consumers (drivers, reactors, `ProviderService`) can only read
 * from the registry. Only the hydration layer — which watches
 * `ServerSettingsService.streamChanges` and applies diffs — imports this
 * tag.
 *
 * The mutator exposes a single entry point, `reconcile(configMap)`, which:
 *
 *   1. Diffs the incoming map against the live one keyed by instance id.
 *   2. Removes every closing entry from routing, publishes the change, and
 *      settles each child `Scope` close before creating any replacements.
 *      A failed close does not prevent siblings from closing. Its outcome
 *      is retained for the registry's lifetime, including across removal
 *      and readdition of the same settings id.
 *   3. Creates added entries and successfully closed replacements. A failed
 *      disposal remains unavailable and cannot be replaced automatically.
 *   4. Publishes `void` ticks when disposal outcomes or newly built entries
 *      change the registry. Consumers re-pull `listInstances` and
 *      `listUnavailable` together.
 *
 * Unchanged live entries and retained disposal failures do not cause scope
 * churn or change notifications. Reconciliation calls are serialized.
 *
 * @module provider/Services/ProviderInstanceRegistryMutator
 */
import type { ProviderInstanceConfigMap } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface ProviderInstanceRegistryMutatorShape {
  /**
   * Bring the live registry in line with the supplied config map. See
   * module docs for the add / remove / replace semantics.
   *
   * Typed driver `create` failures and all removed/replaced scope-close
   * failures become unavailable snapshots. Disposal outcomes are recorded
   * before honoring interruption. Unexpected defects elsewhere can still
   * propagate to the settings watcher's error handler.
   */
  readonly reconcile: (configMap: ProviderInstanceConfigMap) => Effect.Effect<void>;
}

export class ProviderInstanceRegistryMutator extends Context.Service<
  ProviderInstanceRegistryMutator,
  ProviderInstanceRegistryMutatorShape
>()("t3/provider/Services/ProviderInstanceRegistryMutator") {}
