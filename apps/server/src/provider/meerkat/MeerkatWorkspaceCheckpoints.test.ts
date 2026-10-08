import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import {
  ProjectId,
  ProviderInstanceId,
  type ConsoleIdentityRecord,
  type MeerkatWorkspaceCheckpoint,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import type { MeerkatTeamReader } from "./MeerkatTeamReader.ts";
import {
  MeerkatCheckpointStoreService,
  type MeerkatCheckpointScope,
} from "./MeerkatCheckpointStore.ts";
import { makeMeerkatWorkspaceCheckpoints } from "./MeerkatWorkspaceCheckpoints.ts";

const target = {
  projectId: ProjectId.make("project"),
  instanceId: ProviderInstanceId.make("native"),
  agentRef: "reviewer",
};
const canonical = {
  projectPath: "/repo",
  workspace: "/repo",
  stateRoot: "/native/project",
  mobId: "mob",
  sessionId: "session",
};
const idle = {
  ...canonical,
  runtimeGeneration: "runtime-1",
  workspaceGeneration: "workspace-1",
  workspaceStatus: "idle",
  workspaceBusy: false,
};
const record: ConsoleIdentityRecord = {
  identity: "reviewer",
  runtime_key: "default",
  runtime_member_id: "reviewer",
  session_id: "session",
  display_name: "Reviewer",
  visibility: "addressable",
  addressable: true,
  health: "ready",
  labels: {},
};
const harness = Effect.fnUntraced(function* () {
  let returned = idle;
  let beforeGuard: (() => void) | undefined;
  let replace = false;
  let paths: Readonly<Record<string, string>> = {};
  let projectPath = "/repo";
  let stateRoot = "/native/project";
  let checkpoints: ReadonlyArray<MeerkatWorkspaceCheckpoint> = [];
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const saved: Array<MeerkatCheckpointScope> = [];
  const fs = yield* FileSystem.FileSystem;
  const reader = { stateRoot: "/native" } as MeerkatTeamReader;
  const instance = {
    enabled: true,
    instanceId: target.instanceId,
    meerkatTeam: reader,
    meerkatControls: {
      request: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        return returned;
      },
    },
  } as ProviderInstance;
  let reads = 0;
  const registry = Layer.mock(ProviderInstanceRegistry)({
    getInstance: () =>
      Effect.sync(() => {
        reads++;
        return replace && reads > 1 ? { ...instance } : instance;
      }),
  });
  const store = Layer.mock(MeerkatCheckpointStoreService)({
    list: (scope) =>
      Effect.sync(() => {
        saved.push(scope);
        return { checkpoints: [...checkpoints] };
      }),
    preview: () =>
      Effect.succeed({ checkpoint: checkpoints[0]!, files: [], patch: "", sharedWorkspace: true }),
    capture: () => Effect.succeed(checkpoints[0]!),
    restore: (scope, _id, _files, guard) =>
      Effect.gen(function* () {
        beforeGuard?.();
        yield* guard ?? Effect.void;
        saved.push(scope);
        return { restored: ["file.ts"], conflicts: [] };
      }),
  });
  const service = yield* makeMeerkatWorkspaceCheckpoints({
    interactionTarget: () =>
      Effect.succeed({
        reader,
        projectPath,
        stateRoot,
        mobId: "mob",
        mobKind: "domain",
        record,
        ambiguous: false,
      }),
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        registry,
        store,
        Layer.succeed(FileSystem.FileSystem, {
          ...fs,
          realPath: (value) => Effect.succeed(paths[value] ?? value),
        }),
      ),
    ),
  );
  return {
    service,
    calls,
    saved,
    checkpoints: (value: ReadonlyArray<MeerkatWorkspaceCheckpoint>) => {
      checkpoints = value;
    },
    returnScope: (scope: typeof idle) => {
      returned = scope;
    },
    beforeGuard: (run: () => void) => {
      beforeGuard = run;
    },
    aliasPaths: (project: string, state: string) => {
      projectPath = project;
      stateRoot = state;
      paths = { [project]: canonical.projectPath, [state]: canonical.stateRoot };
    },
    replaceAlias: (value: string) => {
      paths = { ...paths, [projectPath]: value };
    },
    replace: () => {
      replace = true;
    },
  };
});

it.effect("returns only a server-verified workspace alias for checkpoint refresh targets", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    h.aliasPaths("/linked-workspace", "/linked-native");
    const checkpoint: MeerkatWorkspaceCheckpoint = {
      id: "checkpoint",
      source: "manual",
      sessionId: canonical.sessionId,
      workspace: canonical.workspace,
      startedAt: "2026-09-29T00:00:00.000Z",
      completedAt: "2026-09-29T00:00:00.000Z",
      status: "complete",
      detail: null,
    };
    h.checkpoints([checkpoint]);
    const expected = { ...checkpoint, workspacePath: "/linked-workspace" };
    expect((yield* h.service.list(target)).checkpoints).toEqual([expected]);
    expect(
      (yield* h.service.preview({ ...target, checkpointId: checkpoint.id })).checkpoint,
    ).toEqual(expected);
    expect(yield* h.service.capture(target)).toEqual(expected);
    h.replaceAlias("/other-workspace");
    expect((yield* Effect.result(h.service.list(target)))._tag).toBe("Failure");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "resolves the native workspace before inspecting or restoring and never trusts client paths",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      expect(yield* h.service.list(target)).toEqual({ checkpoints: [] });
      expect(h.calls[0]).toEqual({
        method: "mobs.v1.checkpointScope",
        params: { ...canonical, includeWorkspaceStatus: true },
      });
      expect(h.saved[0]).toEqual({ ...canonical, instanceId: target.instanceId });
      expect(
        yield* h.service.restore({
          ...target,
          checkpointId: "checkpoint",
          files: [{ path: "file.ts", expectedCurrent: "hash" }],
        }),
      ).toEqual({ restored: ["file.ts"], conflicts: [] });
      expect(h.calls).toHaveLength(3);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "rejects a replacement native session, workspace, storage root, or provider before restoring",
  () =>
    Effect.gen(function* () {
      for (const replacement of [
        { ...idle, sessionId: "new" },
        { ...idle, workspace: "/other" },
        { ...idle, projectPath: "/other" },
        { ...idle, stateRoot: "/other-native" },
        { ...idle, mobId: "other" },
      ]) {
        const h = yield* harness();
        h.returnScope(replacement);
        expect(
          (yield* Effect.result(
            h.service.restore({
              ...target,
              checkpointId: "checkpoint",
              files: [{ path: "file.ts", expectedCurrent: "hash" }],
            }),
          ))._tag,
        ).toBe("Failure");
        expect(h.saved).toEqual([]);
      }
      const h = yield* harness();
      h.replace();
      expect((yield* Effect.result(h.service.list(target)))._tag).toBe("Failure");
      expect(h.saved).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("rechecks native work and connection ownership immediately before restore", () =>
  Effect.gen(function* () {
    for (const state of [
      { ...idle, workspaceStatus: "busy", workspaceBusy: true },
      { ...idle, workspaceStatus: "unknown", workspaceBusy: true },
      { ...idle, runtimeGeneration: "reloaded-runtime" },
      { ...idle, workspaceGeneration: "new-peer-in-workspace" },
    ]) {
      const h = yield* harness();
      h.beforeGuard(() => h.returnScope(state));
      expect(
        (yield* Effect.result(
          h.service.restore({
            ...target,
            checkpointId: "checkpoint",
            files: [{ path: "file.ts", expectedCurrent: "hash" }],
          }),
        ))._tag,
      ).toBe("Failure");
      expect(h.saved).toEqual([]);
    }
    const h = yield* harness();
    h.beforeGuard(h.replace);
    expect(
      (yield* Effect.result(
        h.service.restore({
          ...target,
          checkpointId: "checkpoint",
          files: [{ path: "file.ts", expectedCurrent: "hash" }],
        }),
      ))._tag,
    ).toBe("Failure");
    expect(h.saved).toEqual([]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("accepts realpath-equivalent native scope and rejects a moved alias before restore", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    h.aliasPaths("/repo-link", "/native-link");
    expect(yield* h.service.list(target)).toEqual({ checkpoints: [] });
    expect(h.saved[0]).toEqual({ ...canonical, instanceId: target.instanceId });
    h.beforeGuard(() => h.replaceAlias("/other-repository"));
    expect(
      (yield* Effect.result(
        h.service.restore({
          ...target,
          checkpointId: "checkpoint",
          files: [{ path: "file.ts", expectedCurrent: "hash" }],
        }),
      ))._tag,
    ).toBe("Failure");
    expect(h.saved).toHaveLength(1);
  }).pipe(Effect.provide(NodeServices.layer)),
);
