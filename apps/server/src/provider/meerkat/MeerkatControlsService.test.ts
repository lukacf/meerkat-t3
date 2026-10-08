import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ConsoleIdentityRecord,
  type MeerkatQuestionAnswerInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderRegistry } from "../Services/ProviderRegistry.ts";
import { meerkatProjectStateRoot } from "../Layers/MeerkatAdapter.ts";
import { makeMeerkatControlsService } from "./MeerkatControlsService.ts";
import { makeMeerkatTeamService } from "./MeerkatTeamService.ts";
import { WorkspacePaths } from "../../workspace/WorkspacePaths.ts";
import { ProjectCloneTracker } from "../../project/ProjectCloneTracker.ts";
import type { MeerkatNativeTeamSnapshot, MeerkatTeamReader } from "./MeerkatTeamReader.ts";

const projectId = ProjectId.make("questions-project");
const foreignProjectId = ProjectId.make("foreign-project");
const threadId = ThreadId.make("owned-thread");
const instanceId = ProviderInstanceId.make("questions-native");
const mobId = `t3-${NodeCrypto.createHash("sha256").update(`${instanceId}:${threadId}`).digest("hex")}`;
const worker: ConsoleIdentityRecord = {
  identity: "worker",
  display_name: "Worker",
  runtime_key: "default",
  runtime_member_id: "native-worker",
  session_id: "worker-session",
  visibility: "addressable",
  addressable: true,
  health: "ready",
  labels: { source_mob_id: "child-crew" },
};
const coordinator: ConsoleIdentityRecord = {
  ...worker,
  identity: "ingress",
  runtime_member_id: "ingress",
  session_id: "coordinator-session",
  labels: {},
};
const testLayer = Layer.mergeAll(SqlitePersistenceMemory, Path.layer);
const harness = Effect.fnUntraced(function* () {
  let enabled = true;
  let sessionId = worker.session_id;
  let reply: unknown = { requests: [] };
  let reject: Error | undefined;
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const reader: MeerkatTeamReader = {
    stateRoot: "/questions-provider",
    snapshot: (projectPath) =>
      Effect.sync((): MeerkatNativeTeamSnapshot => ({
        observation: "loaded_runtimes",
        loaded: true,
        mobs:
          projectPath === "/worktrees/owned"
            ? [
                {
                  mobId,
                  kind: "thread",
                  label: "Owned",
                  consoleStatus: "ready",
                  identities: [
                    {
                      ...worker,
                      ...(sessionId ? { session_id: sessionId } : { session_id: undefined }),
                    },
                    coordinator,
                  ],
                },
              ]
            : [],
      })),
    activity: () => Effect.die("Question reads must not read transcripts"),
  };
  const instance: ProviderInstance = {
    instanceId,
    driverKind: ProviderDriverKind.make("meerkat"),
    continuationIdentity: {
      driverKind: ProviderDriverKind.make("meerkat"),
      continuationKey: instanceId,
    },
    displayName: "Native",
    get enabled() {
      return enabled;
    },
    meerkatTeam: reader,
    meerkatControls: {
      request: async (method, params) => {
        calls.push({ method, params });
        if (reject) throw reject;
        return reply;
      },
    },
    get adapter(): never {
      throw Error("No session admission");
    },
    get snapshot(): never {
      throw Error("No catalog refresh");
    },
    get textGeneration(): never {
      throw Error("No model calls");
    },
  };
  const registry = Layer.mock(ProviderInstanceRegistry)({
    listInstances: Effect.succeed([instance]),
    listUnavailable: Effect.succeed([]),
    getInstance: (id) => Effect.succeed(id === instanceId ? instance : undefined),
  });
  const sql = yield* SqlClient.SqlClient;
  for (const id of [projectId, foreignProjectId])
    yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${id},${id},'/project','[]','now','now')`;
  yield* sql`INSERT INTO projection_threads (thread_id,project_id,title,model_selection_json,worktree_path,created_at,updated_at) VALUES (${threadId},${projectId},'Owned','{}','/worktrees/owned','now','now')`;
  yield* sql`INSERT INTO provider_session_runtime (thread_id,provider_name,provider_instance_id,adapter_key,status,last_seen_at) VALUES (${threadId},'meerkat',${instanceId},'meerkat','running','now')`;
  const team = yield* makeMeerkatTeamService.pipe(
    Effect.provide(
      Layer.mergeAll(
        registry,
        Layer.mock(ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
      ),
    ),
  );
  const service = yield* makeMeerkatControlsService(team).pipe(
    Effect.provide(
      Layer.mergeAll(
        registry,
        Layer.mock(ProviderRegistry)({}),
        Layer.mock(WorkspacePaths)({
          normalizeWorkspaceRoot: () => Effect.die("Question and approval scope must not change"),
        }),
      ),
    ),
  );
  const liveWorker = (yield* team.projectTeam({ projectId })).providers[0]!.agents.find(
    (agent) => agent.record.identity === "worker",
  )!;
  const path = yield* Path.Path;
  return {
    service,
    team,
    calls,
    agentRef: liveWorker.agentRef,
    expectedScope: {
      projectPath: "/worktrees/owned",
      stateRoot: meerkatProjectStateRoot(path, reader.stateRoot, "/worktrees/owned"),
      mobId,
    },
    setEnabled: (value: boolean) => {
      enabled = value;
    },
    setSession: (value: string | undefined) => {
      sessionId = value;
    },
    setReply: (value: unknown) => {
      reply = value;
      reject = undefined;
    },
    reject: (error: Error) => {
      reject = error;
    },
  };
});
const answerInput = (agentRef: string): MeerkatQuestionAnswerInput => ({
  projectId,
  instanceId,
  agentRef,
  sessionId: "worker-session",
  requestId: "request-a",
  answers: [{ questionId: "choice", selectedOptionIds: ["yes"], customText: "" }],
  dismissed: false,
});

describe("Meerkat question ownership", () => {
  it.effect("binds approval reads and decisions to the current native invocation owner", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const approval = {
        record: {
          approval_id: "approval-a",
          status: "pending",
          owner: { owner_type: "session", session_id: "worker-session" },
          proposed_action: {
            summary: "Run shell",
            body: { toolName: "shell", arguments: { command: "git status" } },
          },
          created_at: "2026-09-28T12:00:00Z",
        },
        actionable: true,
      };
      const target = { projectId, instanceId, agentRef: h.agentRef };
      h.setReply({ approvals: [approval] });
      expect((yield* h.service.approvals(target)).approvals).toHaveLength(1);
      expect(h.calls[0]).toEqual({
        method: "approvals.v1.list",
        params: { ...h.expectedScope, sessionId: "worker-session" },
      });
      h.setReply({
        approvals: [
          {
            ...approval,
            record: { ...approval.record, owner: { owner_type: "session", session_id: "other" } },
          },
        ],
      });
      expect((yield* Effect.result(h.service.approvals(target)))._tag).toBe("Failure");
      const input = {
        ...target,
        sessionId: "worker-session",
        approvalId: "approval-a",
        decision: "approve" as const,
      };
      h.setSession("replacement");
      expect((yield* Effect.result(h.service.decideApproval(input)))._tag).toBe("Failure");
      expect(h.calls).toHaveLength(2);
      h.setSession("worker-session");
      h.setReply({
        ...approval,
        actionable: false,
        record: { ...approval.record, status: "approved" },
      });
      expect((yield* h.service.decideApproval(input)).record.status).toBe("approved");
      expect(h.calls[2]).toEqual({
        method: "approvals.v1.decide",
        params: {
          ...h.expectedScope,
          sessionId: "worker-session",
          approvalId: "approval-a",
          decision: "approve",
        },
      });
      h.setReply({
        ...approval,
        actionable: false,
        record: { ...approval.record, status: "approved", approval_id: "other" },
      });
      expect((yield* Effect.result(h.service.decideApproval(input)))._tag).toBe("Failure");
    }).pipe(Effect.provide(testLayer)),
  );
  it.effect("uses the actual owning worktree and exact worker or coordinator session", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.service.questions({ projectId, instanceId, agentRef: h.agentRef });
      yield* h.service.questions({ projectId, instanceId, threadId });
      expect(h.calls).toEqual([
        {
          method: "questions.v1.list",
          params: { ...h.expectedScope, sessionId: "worker-session" },
        },
        {
          method: "questions.v1.list",
          params: { ...h.expectedScope, sessionId: "coordinator-session" },
        },
      ]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "rejects foreign, deleted, ambiguous, missing and disabled targets before native calls",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        for (const target of [
          { projectId: foreignProjectId, instanceId, agentRef: h.agentRef },
          { projectId: foreignProjectId, instanceId, threadId },
          { projectId, instanceId, agentRef: h.agentRef, threadId },
          { projectId, instanceId },
          { projectId, instanceId: ProviderInstanceId.make("other"), agentRef: h.agentRef },
        ])
          expect((yield* Effect.result(h.service.questions(target)))._tag).toBe("Failure");
        h.setEnabled(false);
        expect(
          (yield* Effect.result(
            h.service.questions({ projectId, instanceId, agentRef: h.agentRef }),
          ))._tag,
        ).toBe("Failure");
        h.setEnabled(true);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE projection_threads SET deleted_at='now' WHERE thread_id=${threadId}`;
        expect(
          (yield* Effect.result(
            h.service.questions({ projectId, instanceId, agentRef: h.agentRef }),
          ))._tag,
        ).toBe("Failure");
        expect(h.calls).toEqual([]);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "rejects answers after session replacement and forwards valid answers without rewriting them",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        const input = answerInput(h.agentRef);
        expect(
          (yield* Effect.result(h.service.answer({ ...input, sessionId: "other" })))._tag,
        ).toBe("Failure");
        h.setSession("replacement");
        expect((yield* Effect.result(h.service.answer(input)))._tag).toBe("Failure");
        expect(h.calls).toEqual([]);
        h.setSession("worker-session");
        h.setReply({ accepted: true, requestId: input.requestId });
        expect(yield* h.service.answer(input)).toEqual({
          accepted: true,
          requestId: input.requestId,
        });
        expect(h.calls).toEqual([
          {
            method: "questions.v1.answer",
            params: {
              ...h.expectedScope,
              sessionId: "worker-session",
              requestId: input.requestId,
              answers: input.answers,
              dismissed: false,
            },
          },
        ]);
        h.reject(Error("This question is no longer pending"));
        expect((yield* Effect.flip(h.service.answer(input))).message).toContain(
          "no longer pending",
        );
        expect(h.calls).toHaveLength(2);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("does not list a whole mob when a worker has no native session", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      h.setSession(undefined);
      const agent = (yield* h.team.projectTeam({ projectId })).providers[0]!.agents.find(
        (item) => item.record.identity === "worker",
      )!;
      expect(
        (yield* Effect.result(
          h.service.questions({ projectId, instanceId, agentRef: agent.agentRef }),
        ))._tag,
      ).toBe("Failure");
      expect(h.calls).toEqual([]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects foreign-session or foreign-mob questions from the native reader", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const question = {
        requestId: "request",
        sessionId: "worker-session",
        mobId,
        toolCallId: "tool",
        createdAt: "2026-09-28T12:00:00.000Z",
        title: "Question",
        questions: [],
      };
      for (const foreign of [
        { ...question, sessionId: "foreign-session" },
        { ...question, mobId: "foreign-mob" },
      ]) {
        h.setReply({ requests: [foreign] });
        expect(
          (yield* Effect.flip(h.service.questions({ projectId, instanceId, agentRef: h.agentRef })))
            .message,
        ).toContain("different conversation");
      }
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects malformed or mismatched native answer receipts", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      for (const receipt of [
        {},
        { accepted: true, requestId: "other-request" },
        { accepted: false, requestId: "request-a" },
      ]) {
        h.setReply(receipt);
        expect((yield* Effect.result(h.service.answer(answerInput(h.agentRef))))._tag).toBe(
          "Failure",
        );
      }
    }).pipe(Effect.provide(testLayer)),
  );
});
