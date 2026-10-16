import {
  DEFAULT_SERVER_SETTINGS,
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  ProviderSettingsConflictError,
  type ProviderSettingsIntent,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const isProviderConfigRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));

/** Saved donor configuration remains readable, but it cannot activate another runtime. */
export const ensureNativeProviderSettingsIntent = Effect.fnUntraced(function* (
  intent: ProviderSettingsIntent,
) {
  if (intent.kind === "delete") return;
  const driver = intent.kind === "add" ? intent.instance.driver : intent.driver;
  if (driver !== "meerkat") {
    return yield* new ProviderSettingsConflictError({
      instanceId: intent.kind === "resetDefault" ? driver : intent.instanceId,
      reason: "unsupported_driver",
    });
  }
});

export const providerSettingsPatch = Effect.fnUntraced(function* (
  settings: ServerSettings,
  intent: ProviderSettingsIntent,
): Effect.fn.Return<ServerSettingsPatch | undefined, ProviderSettingsConflictError> {
  const instanceId =
    intent.kind === "resetDefault"
      ? defaultInstanceIdForDriver(ProviderDriverKind.make(intent.driver))
      : intent.instanceId;
  const providerInstances = { ...settings.providerInstances };
  const legacyDriver = (
    Object.keys(settings.providers) as Array<keyof ServerSettings["providers"]>
  ).find((driver) => driver === instanceId);
  const explicit = Object.hasOwn(providerInstances, instanceId)
    ? providerInstances[instanceId]
    : undefined;

  if (intent.kind === "add") {
    if (explicit !== undefined || legacyDriver !== undefined) {
      return yield* new ProviderSettingsConflictError({ instanceId, reason: "instance_exists" });
    }
    return { providerInstances: { ...providerInstances, [instanceId]: intent.instance } };
  }
  if (intent.kind === "delete") {
    if (explicit === undefined) return undefined;
    delete providerInstances[instanceId];
    return { providerInstances };
  }
  if (intent.kind === "resetDefault") {
    delete providerInstances[instanceId];
    return {
      providerInstances,
      providers: { [intent.driver]: DEFAULT_SERVER_SETTINGS.providers[intent.driver] },
    };
  }

  const legacy = legacyDriver === undefined ? undefined : settings.providers[legacyDriver];
  let current = explicit;
  if (current === undefined && legacy !== undefined && legacyDriver !== undefined) {
    const { enabled, ...config } = legacy;
    current = { driver: ProviderDriverKind.make(legacyDriver), enabled, config };
  }
  if (current === undefined) {
    return yield* new ProviderSettingsConflictError({ instanceId, reason: "instance_missing" });
  }
  if (current.driver !== intent.driver) {
    return yield* new ProviderSettingsConflictError({ instanceId, reason: "driver_changed" });
  }

  const { changes } = intent;
  const next = { ...current };
  if (changes.enabled !== undefined) next.enabled = changes.enabled;
  if (changes.displayName === null) delete next.displayName;
  else if (changes.displayName !== undefined) next.displayName = changes.displayName;
  if (changes.accentColor === null) delete next.accentColor;
  else if (changes.accentColor !== undefined) next.accentColor = changes.accentColor;
  if (changes.environment === null) delete next.environment;
  else if (changes.environment !== undefined) next.environment = changes.environment;
  if (changes.config !== undefined) {
    if (current.config !== undefined && !isProviderConfigRecord(current.config)) {
      return yield* new ProviderSettingsConflictError({ instanceId, reason: "config_not_object" });
    }
    const config = { ...current.config, ...changes.config.set };
    for (const key of changes.config.remove ?? []) {
      if (changes.config.set !== undefined && Object.hasOwn(changes.config.set, key)) {
        return yield* new ProviderSettingsConflictError({
          instanceId,
          reason: "conflicting_config_keys",
        });
      }
      delete config[key];
    }
    next.config = config;
  }
  return {
    providerInstances: { ...providerInstances, [instanceId]: next },
    ...(legacyDriver === undefined
      ? {}
      : { providers: { [legacyDriver]: DEFAULT_SERVER_SETTINGS.providers[legacyDriver] } }),
    ...(changes.enabled === false && settings.textGenerationModelSelection.instanceId === instanceId
      ? { textGenerationModelSelection: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection }
      : {}),
  };
});
