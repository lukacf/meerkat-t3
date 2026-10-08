import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { SettingsScopeSearch } from "./settingsScope";

export interface ProviderAccountSearch extends SettingsScopeSearch {
  environmentId?: EnvironmentId | undefined;
  instanceId?: ProviderInstanceId | undefined;
  accountProject?: string | undefined;
  accountThread?: string | undefined;
  accountCwd?: string | undefined;
}

export interface ProviderAccountTarget {
  environmentId: EnvironmentId;
  instanceId: ProviderInstanceId;
  projectId: ProjectId;
  threadTarget: { threadId: ThreadId; expectedCwd: string };
}

const ACCOUNT_KEYS = ["accountProject", "accountThread", "accountCwd"] as const;

/** Keep malformed links explicit, so they cannot become a parent account request. */
export function validateProviderAccountSearch(raw: Record<string, unknown>) {
  return Object.fromEntries(
    ACCOUNT_KEYS.filter((key) => raw[key] !== undefined).map((key) => [
      key,
      typeof raw[key] === "string" ? raw[key] : "",
    ]),
  ) as Pick<ProviderAccountSearch, (typeof ACCOUNT_KEYS)[number]>;
}

export function resolveProviderAccountTarget(
  search: ProviderAccountSearch,
): { kind: "none" } | { kind: "invalid" } | { kind: "thread"; target: ProviderAccountTarget } {
  if (ACCOUNT_KEYS.every((key) => search[key] === undefined)) return { kind: "none" };
  if (
    !search.environmentId ||
    !search.instanceId ||
    !search.accountProject?.trim() ||
    !search.accountThread?.trim() ||
    !search.accountCwd?.trim() ||
    (search.machine !== undefined && search.machine !== search.environmentId) ||
    search.project !== undefined ||
    search.checkout !== undefined
  )
    return { kind: "invalid" };
  return {
    kind: "thread",
    target: {
      environmentId: search.environmentId,
      instanceId: search.instanceId,
      projectId: ProjectId.make(search.accountProject),
      threadTarget: {
        threadId: ThreadId.make(search.accountThread),
        expectedCwd: search.accountCwd,
      },
    },
  };
}

/** Account targeting never changes the registered-project settings write scope. */
export function providerAccountSettingsSearch(input: {
  environmentId: EnvironmentId;
  instanceId: ProviderInstanceId;
  projectId: ProjectId | undefined;
  threadId?: ThreadId | undefined;
  cwd?: string | undefined;
  fallback: SettingsScopeSearch;
}): ProviderAccountSearch & { environmentId: EnvironmentId; instanceId: ProviderInstanceId } {
  return input.threadId
    ? {
        environmentId: input.environmentId,
        instanceId: input.instanceId,
        machine: input.environmentId,
        project: undefined,
        checkout: undefined,
        accountProject: input.projectId ?? "",
        accountThread: input.threadId,
        accountCwd: input.cwd ?? "",
      }
    : { ...input.fallback, environmentId: input.environmentId, instanceId: input.instanceId };
}
