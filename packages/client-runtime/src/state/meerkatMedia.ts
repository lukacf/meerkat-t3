import { WS_METHODS, type EnvironmentId, type MeerkatMediaTarget } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/unstable/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

// Browser controls and workspace handoffs create separate media atom families.
// Share their invalidation signal, scoped to the native target being changed.
const browserRevisionByTarget = Atom.family((key: string) =>
  Atom.make(0).pipe(Atom.keepAlive, Atom.withLabel(`meerkat:browser-revision:${key}`)),
);

function browserRevision(target: {
  readonly environmentId: EnvironmentId;
  readonly input: MeerkatMediaTarget;
}) {
  return browserRevisionByTarget(
    JSON.stringify([
      target.environmentId,
      target.input.projectId,
      target.input.instanceId,
      target.input.agentRef ?? null,
      target.input.threadId ?? null,
    ]),
  );
}

export function createMeerkatMediaAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    browserStatus: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "meerkat:browser-status",
      tag: WS_METHODS.meerkatBrowserStatus,
      staleTimeMs: 2_000,
      idleTtlMs: 60_000,
      refreshTrigger: browserRevision,
    }),
    browserGrant: createEnvironmentRpcCommand(runtime, {
      label: "meerkat:browser-grant",
      tag: WS_METHODS.meerkatBrowserGrant,
      onSuccess: (target, registry) =>
        Effect.sync(() => registry.update(browserRevision(target), (revision) => revision + 1)),
    }),
    imageUpload: createEnvironmentRpcCommand(runtime, {
      label: "meerkat:image-upload",
      tag: WS_METHODS.meerkatImageUpload,
    }),
    imageRead: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "meerkat:image-read",
      tag: WS_METHODS.meerkatImageRead,
      staleTimeMs: 60_000,
      idleTtlMs: 60_000,
    }),
  };
}
