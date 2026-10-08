import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSettingsConflictError,
  ProviderSettingsIntent,
  ServerSettings,
} from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { providerSettingsPatch } from "./providerSettingsIntent.ts";

const isProviderSettingsConflict = Schema.is(ProviderSettingsConflictError);
const A = ProviderInstanceId.make("custom_a");
const B = ProviderInstanceId.make("custom_b");
const DRIVER = ProviderDriverKind.make("fork");
const decode = Schema.decodeUnknownEffect(ProviderSettingsIntent);
const initial: ServerSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  providerInstances: {
    [A]: {
      driver: DRIVER,
      enabled: true,
      displayName: "Before",
      accentColor: "red",
      config: { keep: { opaque: [1, 2] }, change: "old", remove: true },
    },
    [B]: { driver: DRIVER, config: ["opaque"] },
  },
};
const apply = Effect.fnUntraced(function* (settings: ServerSettings, input: unknown) {
  const patch = yield* providerSettingsPatch(settings, yield* decode(input));
  return patch === undefined ? settings : applyServerSettingsPatch(settings, patch);
});

it.effect(
  "provider intents preserve untouched envelope fields, config keys and opaque siblings",
  () =>
    Effect.gen(function* () {
      const next = yield* apply(initial, {
        kind: "edit",
        instanceId: A,
        driver: DRIVER,
        changes: { config: { set: { change: "new" }, remove: ["remove"] } },
      });
      assert.deepEqual(next.providerInstances[A], {
        ...initial.providerInstances[A]!,
        config: { keep: { opaque: [1, 2] }, change: "new" },
      });
      assert.deepEqual(next.providerInstances[B], initial.providerInstances[B]);
    }),
);

it.effect(
  "provider intents remove optional fields only on explicit null and replace environment as one field",
  () =>
    Effect.gen(function* () {
      const withEnv = yield* apply(initial, {
        kind: "edit",
        instanceId: A,
        driver: DRIVER,
        changes: {
          environment: [{ name: "PRIVATE", value: "", sensitive: true, valueRedacted: true }],
        },
      });
      const renamed = yield* apply(withEnv, {
        kind: "edit",
        instanceId: A,
        driver: DRIVER,
        changes: { displayName: "After" },
      });
      assert.deepEqual(
        renamed.providerInstances[A]?.environment,
        withEnv.providerInstances[A]?.environment,
      );
      const cleared = yield* apply(renamed, {
        kind: "edit",
        instanceId: A,
        driver: DRIVER,
        changes: { displayName: null, accentColor: null, environment: null },
      });
      assert.notProperty(cleared.providerInstances[A], "displayName");
      assert.notProperty(cleared.providerInstances[A], "accentColor");
      assert.notProperty(cleared.providerInstances[A], "environment");
    }),
);

it.effect("provider intents do not recreate deleted instances and repeated delete is a no-op", () =>
  Effect.gen(function* () {
    const removed = yield* apply(initial, { kind: "delete", instanceId: A });
    assert.strictEqual(yield* apply(removed, { kind: "delete", instanceId: A }), removed);
    const result = yield* apply(removed, {
      kind: "edit",
      instanceId: A,
      driver: DRIVER,
      changes: { enabled: false },
    }).pipe(Effect.result);
    assert.isTrue(
      result._tag === "Failure" &&
        isProviderSettingsConflict(result.failure) &&
        result.failure.reason === "instance_missing",
    );
  }),
);

for (const driver of Object.keys(DEFAULT_SERVER_SETTINGS.providers)) {
  it.effect(`provider intents reject add over synthesized default ${driver}`, () =>
    Effect.gen(function* () {
      const result = yield* apply(DEFAULT_SERVER_SETTINGS, {
        kind: "add",
        instanceId: driver,
        instance: { driver: DRIVER },
      }).pipe(Effect.result);
      assert.isTrue(
        result._tag === "Failure" &&
          isProviderSettingsConflict(result.failure) &&
          result.failure.reason === "instance_exists",
      );
    }),
  );
}

it.effect(
  "provider intents edit a synthesized default and reset only its legacy and explicit slots",
  () =>
    Effect.gen(function* () {
      const settings: ServerSettings = {
        ...initial,
        providers: {
          ...initial.providers,
          codex: { ...initial.providers.codex, binaryPath: "/custom/codex", enabled: false },
          cursor: { ...initial.providers.cursor, binaryPath: "/keep/cursor" },
        },
      };
      const edited = yield* apply(settings, {
        kind: "edit",
        instanceId: "codex",
        driver: "codex",
        changes: { enabled: true, config: { set: { homePath: "/new/home" } } },
      });
      const { enabled: _enabled, ...config } = settings.providers.codex;
      assert.deepInclude(edited.providerInstances[ProviderInstanceId.make("codex")], {
        enabled: true,
        config: { ...config, homePath: "/new/home" },
      });
      const reset = yield* apply(edited, { kind: "resetDefault", driver: "codex" });
      assert.notProperty(reset.providerInstances, "codex");
      assert.deepEqual(reset.providers.codex, DEFAULT_SERVER_SETTINGS.providers.codex);
      assert.deepEqual(reset.providers.cursor, settings.providers.cursor);
      assert.deepEqual(reset.providerInstances[A], initial.providerInstances[A]);
    }),
);

for (const [changes, instanceId, driver, reason] of [
  [{ enabled: false }, A, "another", "driver_changed"],
  [{ config: { set: { value: 1 } } }, B, DRIVER, "config_not_object"],
  [
    { config: { set: { keep: "secret-looking-value" }, remove: ["keep"] } },
    A,
    DRIVER,
    "conflicting_config_keys",
  ],
] as const) {
  it.effect(`provider intents reject ${reason} without including config values`, () =>
    Effect.gen(function* () {
      const result = yield* apply(initial, { kind: "edit", instanceId, driver, changes }).pipe(
        Effect.result,
      );
      assert.isTrue(result._tag === "Failure");
      if (result._tag === "Failure" && isProviderSettingsConflict(result.failure)) {
        assert.equal(result.failure.reason, reason);
        assert.notInclude(result.failure.message, "secret-looking-value");
      } else assert.fail("Expected a typed provider conflict");
    }),
  );
}

it.effect("provider intents clear only the disabled selected text writer", () =>
  Effect.gen(function* () {
    const settings = {
      ...initial,
      textGenerationModelSelection: { instanceId: A, model: "chosen" },
    };
    const other = yield* apply(settings, {
      kind: "edit",
      instanceId: B,
      driver: DRIVER,
      changes: { enabled: false },
    });
    assert.deepEqual(other.textGenerationModelSelection, settings.textGenerationModelSelection);
    const selected = yield* apply(other, {
      kind: "edit",
      instanceId: A,
      driver: DRIVER,
      changes: { enabled: false },
    });
    assert.deepEqual(
      selected.textGenerationModelSelection,
      DEFAULT_SERVER_SETTINGS.textGenerationModelSelection,
    );
  }),
);
