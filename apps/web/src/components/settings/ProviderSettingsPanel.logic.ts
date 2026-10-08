import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { ProviderSettingsIntent } from "@t3tools/client-runtime/state/server";
import {
  AuthOrchestrationOperateScope,
  type AuthSessionState,
  type EnvironmentId,
  type ProviderInstanceId,
  type ProviderInstanceConfig,
  resolveProviderInstanceEnabled,
} from "@t3tools/contracts";

/** Capture only the fields changed by this editor, not its settings snapshot. */
export function buildProviderSettingsEdit(
  instanceId: ProviderInstanceId,
  previous: ProviderInstanceConfig,
  next: ProviderInstanceConfig,
): ProviderSettingsIntent {
  const previousConfig =
    previous.config !== null && typeof previous.config === "object"
      ? (previous.config as Record<string, unknown>)
      : {};
  const nextConfig =
    next.config !== null && typeof next.config === "object"
      ? (next.config as Record<string, unknown>)
      : {};
  const set = Object.fromEntries(
    Object.entries(nextConfig).filter(([key, value]) => !Object.is(previousConfig[key], value)),
  );
  const remove = Object.keys(previousConfig).filter((key) => !Object.hasOwn(nextConfig, key));
  return {
    kind: "edit",
    instanceId,
    driver: previous.driver,
    changes: {
      ...(next.enabled !== previous.enabled && next.enabled !== undefined
        ? { enabled: next.enabled }
        : {}),
      ...(next.displayName !== previous.displayName
        ? { displayName: next.displayName ?? null }
        : {}),
      ...(next.accentColor !== previous.accentColor
        ? { accentColor: next.accentColor ?? null }
        : {}),
      ...(next.environment !== previous.environment
        ? { environment: next.environment ?? null }
        : {}),
      ...(Object.keys(set).length > 0 || remove.length > 0 ? { config: { set, remove } } : {}),
    },
  };
}

/** Keep configured alternatives visible after the enabled native runtime. */
export function orderProviderSettingsRows<
  T extends { readonly instance: Pick<ProviderInstanceConfig, "driver" | "enabled" | "config"> },
>(rows: readonly T[]): T[] {
  const priority = (row: T) =>
    resolveProviderInstanceEnabled(row.instance) ? (row.instance.driver === "meerkat" ? 0 : 1) : 2;
  return rows.toSorted((left, right) => priority(left) - priority(right));
}

/** Keep explicit choices, but begin setup with a provider that is actually enabled. */
export function selectProviderSettingsRow<
  T extends {
    readonly instanceId: ProviderInstanceId;
    readonly instance: Pick<ProviderInstanceConfig, "driver" | "enabled" | "config">;
  },
>(
  rows: readonly T[],
  selectedInstanceId: ProviderInstanceId | null,
  targetInstanceId?: ProviderInstanceId,
): T | null {
  const selected = rows.find((row) => row.instanceId === selectedInstanceId);
  if (selected) return selected;
  if (targetInstanceId !== undefined && selectedInstanceId === targetInstanceId) return null;
  return rows.find((row) => resolveProviderInstanceEnabled(row.instance)) ?? rows[0] ?? null;
}

export interface ProviderEnvironmentOptionLike {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

export function isProviderSettingsEnvironmentAvailable(input: {
  readonly connectionPhase: EnvironmentConnectionPhase;
  readonly hasServerConfig: boolean;
}): boolean {
  return input.connectionPhase === "connected" && input.hasServerConfig;
}

export function buildProviderEnvironmentOptions<T extends ProviderEnvironmentOptionLike>(
  environments: ReadonlyArray<T>,
  primaryEnvironmentId: EnvironmentId | null,
): ReadonlyArray<T> {
  return environments.toSorted((left, right) => {
    const leftIsPrimary = left.environmentId === primaryEnvironmentId;
    const rightIsPrimary = right.environmentId === primaryEnvironmentId;
    if (leftIsPrimary !== rightIsPrimary) {
      return leftIsPrimary ? -1 : 1;
    }
    return (
      left.label.localeCompare(right.label) ||
      String(left.environmentId).localeCompare(String(right.environmentId))
    );
  });
}

export function resolveSelectedProviderEnvironmentId(
  environments: ReadonlyArray<ProviderEnvironmentOptionLike>,
  selectedEnvironmentId: EnvironmentId | null,
  primaryEnvironmentId: EnvironmentId | null,
): EnvironmentId | null {
  if (
    selectedEnvironmentId !== null &&
    environments.some((environment) => environment.environmentId === selectedEnvironmentId)
  ) {
    return selectedEnvironmentId;
  }
  if (
    primaryEnvironmentId !== null &&
    environments.some((environment) => environment.environmentId === primaryEnvironmentId)
  ) {
    return primaryEnvironmentId;
  }
  return environments[0]?.environmentId ?? null;
}

export type ProviderEnvironmentAccess =
  | { readonly kind: "editable" }
  /** `reason` distinguishes waiting on the device from waiting on permissions. */
  | { readonly kind: "loading"; readonly reason: "config" | "permissions" }
  | { readonly kind: "read-only" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "error" };

/**
 * Whether the session may change provider configuration on an environment.
 * `pending` means the answer is still unknown, which must not be presented as
 * editable: rendering controls we already know might be rejected only turns a
 * permission problem into a failed write.
 */
export type ProviderOperateAccess = "granted" | "denied" | "pending";

/**
 * Resolve operate access from an environment's `/api/auth/session` answer.
 *
 * Cached session data wins over an in-flight revalidation. The session atoms
 * are SWR-backed, so they report `isPending` on every background refresh;
 * treating that as unknown would flip a working panel back to loading and
 * discard in-progress edits.
 *
 * `missingScopesAccess` decides the case where the session resolved but did
 * not report scopes: the primary serves the web app itself so its server
 * always reports them (absence means denial), while a remote device may run an
 * older server version that predates scope reporting, where denial would lock
 * out a legitimate session. The environment RPC layer stays authoritative
 * either way.
 */
function resolveSessionOperateAccess(input: {
  readonly session: Pick<AuthSessionState, "authenticated" | "scopes"> | null;
  readonly isPending: boolean;
  readonly hasError: boolean;
  readonly missingScopesAccess: "granted" | "denied";
}): ProviderOperateAccess {
  if (input.session === null) {
    if (input.isPending) {
      return "pending";
    }
    // A failed session fetch is a transport problem, not a permission
    // decision — locking the panel read-only would misreport it. Stay
    // optimistic; the environment RPC layer still rejects unauthorized writes.
    return input.hasError ? "granted" : "denied";
  }
  if (!input.session.authenticated) {
    return "denied";
  }
  if (input.session.scopes === undefined) {
    return input.missingScopesAccess;
  }
  return input.session.scopes.includes(AuthOrchestrationOperateScope) ? "granted" : "denied";
}

/** Operate access for the primary environment's own browser session. */
export function resolvePrimaryOperateAccess(input: {
  readonly isPrimary: boolean;
  readonly hasDesktopBridge: boolean;
  readonly session: Pick<AuthSessionState, "authenticated" | "scopes"> | null;
  readonly isPending: boolean;
  readonly hasError: boolean;
}): ProviderOperateAccess {
  if (!input.isPrimary || input.hasDesktopBridge) {
    return "granted";
  }
  return resolveSessionOperateAccess({
    session: input.session,
    isPending: input.isPending,
    hasError: input.hasError,
    missingScopesAccess: "denied",
  });
}

/**
 * Operate access for a non-primary environment, derived from the scopes its
 * `/api/auth/session` endpoint reports for this client's credential.
 */
export function resolveRemoteOperateAccess(input: {
  readonly session: Pick<AuthSessionState, "authenticated" | "scopes"> | null;
  readonly isPending: boolean;
  readonly hasError: boolean;
}): ProviderOperateAccess {
  return resolveSessionOperateAccess({
    ...input,
    missingScopesAccess: "granted",
  });
}

export function classifyProviderEnvironmentAccess(input: {
  readonly connectionPhase: EnvironmentConnectionPhase;
  readonly hasServerConfig: boolean;
  readonly operateAccess: ProviderOperateAccess;
}): ProviderEnvironmentAccess {
  if (input.connectionPhase === "error") {
    return { kind: "error" };
  }
  if (input.connectionPhase !== "connected") {
    return { kind: "unavailable" };
  }
  if (!input.hasServerConfig) {
    return { kind: "loading", reason: "config" };
  }
  if (input.operateAccess === "pending") {
    return { kind: "loading", reason: "permissions" };
  }
  if (input.operateAccess === "denied") {
    return { kind: "read-only" };
  }
  return { kind: "editable" };
}
