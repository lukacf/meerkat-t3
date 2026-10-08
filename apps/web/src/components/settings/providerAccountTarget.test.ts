import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  providerAccountSettingsSearch,
  resolveProviderAccountTarget,
  validateProviderAccountSearch,
} from "./providerAccountTarget";
import { validateSettingsRouteSearch } from "./settingsScopeNavigation";

const base = {
  environmentId: EnvironmentId.make("machine-a"),
  instanceId: ProviderInstanceId.make("native"),
  projectId: ProjectId.make("project"),
  threadId: ThreadId.make("thread"),
  cwd: "/worktrees/task-a",
  fallback: { machine: "other-machine", project: "logical-group", checkout: "parent" },
};

describe("thread account navigation", () => {
  it("keeps the exact task checkout separate from project override scope", () => {
    const search = providerAccountSettingsSearch(base);
    expect(validateSettingsRouteSearch({ ...search })).toEqual({ machine: "machine-a" });
    expect(resolveProviderAccountTarget(search)).toEqual({
      kind: "thread",
      target: {
        environmentId: "machine-a",
        instanceId: "native",
        projectId: "project",
        threadTarget: { threadId: "thread", expectedCwd: "/worktrees/task-a" },
      },
    });
    const other = providerAccountSettingsSearch({
      ...base,
      environmentId: EnvironmentId.make("machine-b"),
      cwd: "/worktrees/task-b",
    });
    expect(resolveProviderAccountTarget(other)).toMatchObject({
      target: { environmentId: "machine-b", threadTarget: { expectedCwd: "/worktrees/task-b" } },
    });
  });

  it.each([
    { accountCwd: undefined },
    { accountCwd: "" },
    { accountThread: undefined },
    { accountProject: undefined },
    { environmentId: undefined },
    { instanceId: undefined },
    { machine: "other-machine" },
    { project: "parent" },
    { checkout: "parent" },
  ])("rejects an incomplete or conflicting account target %j", (patch) => {
    expect(
      resolveProviderAccountTarget({ ...providerAccountSettingsSearch(base), ...patch }),
    ).toEqual({ kind: "invalid" });
  });

  it("preserves malformed account keys as invalid instead of falling back", () => {
    const raw = { accountThread: { id: "thread" } };
    expect(resolveProviderAccountTarget(validateProviderAccountSearch(raw))).toEqual({
      kind: "invalid",
    });
    expect(resolveProviderAccountTarget({})).toEqual({ kind: "none" });
  });

  it("does not broaden a worker whose checkout is missing", () => {
    expect(
      resolveProviderAccountTarget(providerAccountSettingsSearch({ ...base, cwd: undefined })),
    ).toEqual({ kind: "invalid" });
  });

  it("retains existing project account navigation before a thread exists", () => {
    const search = providerAccountSettingsSearch({ ...base, threadId: undefined });
    expect(search).toMatchObject({ ...base.fallback, instanceId: "native" });
    expect(resolveProviderAccountTarget(search)).toEqual({ kind: "none" });
  });
});
