import {
  MeerkatAuthOverview,
  MeerkatQuestionAnswerReceipt,
  MeerkatQuestions,
  MeerkatApproval,
  MeerkatApprovals,
  type MeerkatApprovalDecisionInput,
  MeerkatControlError,
  type MeerkatControlScope,
  type MeerkatQuestionTarget,
  type MeerkatQuestionAnswerInput,
  type MeerkatAuthActionInput,
  type MeerkatAuthScope,
  type MeerkatAuthConnection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderRegistry } from "../Services/ProviderRegistry.ts";
import { meerkatProjectStateRoot } from "../Layers/MeerkatAdapter.ts";
import { createMeerkatAuthFlows } from "./MeerkatAuthFlows.ts";
import type { makeMeerkatTeamService } from "./MeerkatTeamService.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import { WorkspacePaths } from "../../workspace/WorkspacePaths.ts";
import { withWorkspaceLease } from "../../workspace/workspaceLease.ts";

const flows = createMeerkatAuthFlows();
const authInstanceIds = new WeakMap<ProviderInstance, number>();
let nextAuthInstanceId = 0;
const authInstanceId = (instance: ProviderInstance) => {
  const existing = authInstanceIds.get(instance);
  if (existing !== undefined) return existing;
  const id = ++nextAuthInstanceId;
  authInstanceIds.set(instance, id);
  return id;
};
const decodeAuthOverview = Schema.decodeUnknownSync(MeerkatAuthOverview);
const decodeQuestions = Schema.decodeUnknownSync(MeerkatQuestions);
const decodeAnswer = Schema.decodeUnknownSync(MeerkatQuestionAnswerReceipt);
const decodeApprovals = Schema.decodeUnknownSync(MeerkatApprovals);
const decodeApproval = Schema.decodeUnknownSync(MeerkatApproval);
const ProjectRows = Schema.Array(Schema.Struct({ workspace_root: Schema.String }));
const AuthThreadRows = Schema.Array(
  Schema.Struct({ project_id: Schema.String, worktree_path: Schema.NullOr(Schema.String) }),
);
export const makeMeerkatControlsService = Effect.fn("makeMeerkatControlsService")(function* (
  team: Pick<Effect.Success<typeof makeMeerkatTeamService>, "interactionTarget">,
  authFlows = flows,
) {
  const registry = yield* ProviderInstanceRegistry;
  const providerSnapshots = yield* ProviderRegistry;
  const sql = yield* SqlClient.SqlClient;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths;
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  const failure = (input: typeof MeerkatControlScope.Type, cause: unknown) =>
    new MeerkatControlError({
      projectId: input.projectId,
      message: cause instanceof Error ? cause.message : String(cause),
    });
  const provider = Effect.fn("MeerkatControls.provider")(function* (
    input: typeof MeerkatControlScope.Type,
  ) {
    const instance = yield* registry.getInstance(input.instanceId);
    if (!instance?.enabled || !instance.meerkatControls || !instance.meerkatTeam)
      return yield* failure(input, "This Meerkat connection is unavailable.");
    const rows =
      yield* sql`SELECT workspace_root FROM projection_projects WHERE project_id = ${input.projectId} AND deleted_at IS NULL`.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(ProjectRows)),
        Effect.mapError((cause) => failure(input, cause)),
      );
    if (!rows[0]) return yield* failure(input, "Project not found.");
    const projectPath = path.resolve(rows[0].workspace_root);
    return {
      instance,
      request: instance.meerkatControls.request,
      params: {
        projectPath,
        stateRoot: meerkatProjectStateRoot(path, instance.meerkatTeam.stateRoot, projectPath),
      },
    };
  });
  const authTarget = Effect.fn("MeerkatControls.authTarget")(function* (input: MeerkatAuthScope) {
    const target = yield* provider(input);
    const projectRoot = target.params.projectPath;
    let projectPath = projectRoot;
    if (input.threadTarget) {
      const rows = yield* sql`
        SELECT project_id, worktree_path FROM projection_threads
        WHERE thread_id = ${input.threadTarget.threadId}
          AND deleted_at IS NULL AND archived_at IS NULL
      `.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(AuthThreadRows)),
        Effect.mapError((cause) => failure(input, cause)),
      );
      if (!rows[0] || rows[0].project_id !== input.projectId)
        return yield* failure(
          input,
          "This conversation is no longer available in the selected project.",
        );
      projectPath = path.resolve(rows[0].worktree_path ?? projectRoot);
      if (
        !path.isAbsolute(input.threadTarget.expectedCwd) ||
        path.resolve(input.threadTarget.expectedCwd) !== projectPath
      )
        return yield* failure(
          input,
          "This conversation's checkout changed. Reopen its account settings.",
        );
      yield* workspacePaths
        .normalizeWorkspaceRoot(projectPath)
        .pipe(Effect.mapError((cause) => failure(input, cause)));
    }
    return {
      ...target,
      projectRoot,
      params: {
        projectPath,
        stateRoot: meerkatProjectStateRoot(
          path,
          target.instance.meerkatTeam!.stateRoot,
          projectPath,
        ),
      },
    };
  });
  type AuthTarget = Effect.Success<ReturnType<typeof authTarget>>;
  const currentAuthTarget = Effect.fn("MeerkatControls.currentAuthTarget")(function* (
    input: MeerkatAuthScope,
    original: AuthTarget,
  ) {
    const current = yield* authTarget(input);
    if (
      current.instance !== original.instance ||
      current.projectRoot !== original.projectRoot ||
      current.params.projectPath !== original.params.projectPath ||
      current.params.stateRoot !== original.params.stateRoot
    )
      return yield* failure(input, "This account target changed. Reopen its account settings.");
    return current;
  });
  const authRequest = Effect.fn("MeerkatControls.authRequest")(function* (
    input: MeerkatAuthScope,
    original: AuthTarget,
    method: string,
    params: Record<string, unknown>,
    connection?: MeerkatAuthConnection,
  ) {
    return yield* withWorkspaceLease(
      original.params.projectPath,
      Effect.gen(function* () {
        let current = yield* currentAuthTarget(input, original);
        if (method === "auth.v1.loginComplete" && connection) {
          const overview = yield* Effect.tryPromise({
            try: async () =>
              decodeAuthOverview(await current.request("auth.v1.status", current.params)),
            catch: (cause) => failure(input, cause),
          });
          const resolved = overview.connections.find(
            (entry) => entry.provider === connection.provider,
          );
          if (
            !resolved?.supportsInteractiveLogin ||
            resolved.realmId !== connection.realmId ||
            resolved.bindingId !== connection.bindingId ||
            resolved.profileId !== connection.profileId ||
            resolved.source !== connection.source
          )
            return yield* failure(input, "The account configuration changed. Start a new sign-in.");
          current = yield* currentAuthTarget(input, original);
        }
        const result = yield* Effect.tryPromise({
          try: () => current.request(method, { ...params, ...current.params }),
          catch: (cause) => failure(input, cause),
        });
        // Do not show a stale account read under a newly selected checkout.
        if (method === "auth.v1.status") yield* currentAuthTarget(input, original);
        return result;
      }),
    );
  });
  const questionTarget = Effect.fn("MeerkatControls.questionTarget")(function* (
    input: MeerkatQuestionTarget,
  ) {
    const { request } = yield* provider(input);
    const target = yield* team
      .interactionTarget({
        projectId: input.projectId,
        instanceId: input.instanceId,
        ...(input.agentRef ? { agentRef: input.agentRef } : {}),
        ...(input.threadId ? { threadId: input.threadId } : {}),
      })
      .pipe(Effect.mapError((cause) => failure(input, cause)));
    if (!target.record.session_id)
      return yield* failure(input, "This agent has no active native session.");
    return {
      request,
      params: {
        projectPath: target.projectPath,
        stateRoot:
          target.stateRoot ??
          meerkatProjectStateRoot(path, target.reader.stateRoot, target.projectPath),
        mobId: target.mobId,
        sessionId: target.record.session_id,
      },
    };
  });
  const questions = Effect.fn("MeerkatControls.questions")(function* (
    input: MeerkatQuestionTarget,
  ) {
    const { request, params } = yield* questionTarget(input);
    return yield* Effect.tryPromise({
      try: async () => {
        const result = decodeQuestions(await request("questions.v1.list", params));
        if (
          result.requests.some(
            (question) =>
              question.sessionId !== params.sessionId || question.mobId !== params.mobId,
          )
        )
          throw new Error(
            "The native question belongs to a different conversation. Refresh before answering.",
          );
        return result;
      },
      catch: (cause) => failure(input, cause),
    });
  });
  const answer = Effect.fn("MeerkatControls.answer")(function* (input: MeerkatQuestionAnswerInput) {
    const { request, params } = yield* questionTarget(input);
    if (params.sessionId !== input.sessionId)
      return yield* failure(input, "This question belongs to a previous agent session.");
    return yield* Effect.tryPromise({
      try: async () => {
        const receipt = decodeAnswer(
          await request("questions.v1.answer", {
            ...params,
            requestId: input.requestId,
            answers: input.answers,
            dismissed: input.dismissed,
          }),
        );
        if (!receipt.accepted || receipt.requestId !== input.requestId)
          throw new Error("The native runtime did not confirm this question answer.");
        return receipt;
      },
      catch: (cause) => failure(input, cause),
    });
  });
  const authStatus = Effect.fn("MeerkatControls.authStatus")(function* (input: MeerkatAuthScope) {
    const target = yield* authTarget(input);
    const result = yield* authRequest(input, target, "auth.v1.status", {}).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(MeerkatAuthOverview)),
      Effect.mapError((cause) => failure(input, cause)),
    );
    return {
      ...result,
      workspace: {
        projectId: input.projectId,
        ...(input.threadTarget ? { threadId: input.threadTarget.threadId } : {}),
        cwd: target.params.projectPath,
      },
    };
  });
  const approvals = Effect.fn("MeerkatControls.approvals")(function* (
    input: MeerkatQuestionTarget,
  ) {
    const { request, params } = yield* questionTarget(input);
    return yield* Effect.tryPromise({
      try: async () => {
        const result = decodeApprovals(await request("approvals.v1.list", params));
        if (result.approvals.some((row) => row.record.owner.session_id !== params.sessionId)) {
          throw new Error("The native approval belongs to another conversation.");
        }
        return result;
      },
      catch: (cause) => failure(input, cause),
    });
  });
  const decideApproval = Effect.fn("MeerkatControls.decideApproval")(function* (
    input: MeerkatApprovalDecisionInput,
  ) {
    const { request, params } = yield* questionTarget(input);
    if (params.sessionId !== input.sessionId)
      return yield* failure(input, "This approval belongs to a previous agent session.");
    return yield* Effect.tryPromise({
      try: async () => {
        const result = decodeApproval(
          await request("approvals.v1.decide", {
            ...params,
            approvalId: input.approvalId,
            decision: input.decision,
          }),
        );
        if (
          result.record.owner.session_id !== params.sessionId ||
          result.record.approval_id !== input.approvalId ||
          result.actionable ||
          result.record.status !== (input.decision === "approve" ? "approved" : "denied")
        ) {
          throw new Error("The native runtime did not confirm this exact approval decision.");
        }
        return result;
      },
      catch: (cause) => failure(input, cause),
    });
  });
  const refreshAccountProjection = Effect.fn("MeerkatControls.refreshAccountProjection")(function* (
    input: MeerkatAuthScope,
    original: AuthTarget,
  ) {
    const target = yield* currentAuthTarget(input, original);
    yield* providerSnapshots.refreshWorkspaceSnapshot({
      instanceId: input.instanceId,
      cwd: target.params.projectPath,
      invalidate: true,
    });
    yield* currentAuthTarget(input, original);
    yield* providerSnapshots.refreshInstance(input.instanceId);
  });
  const authAction = Effect.fn("MeerkatControls.authAction")(function* (
    input: MeerkatAuthActionInput,
    owner: string,
  ) {
    const target = yield* authTarget(input);
    const { params } = target;
    const cancellationScope = `${input.instanceId}:${params.stateRoot}:instance:${authInstanceId(target.instance)}`;
    const scope = `${cancellationScope}${input.threadTarget ? `:thread:${input.threadTarget.threadId}` : ""}`;
    const result = yield* Effect.tryPromise({
      try: async () => {
        if (input.action === "status")
          return authFlows.status(input.flowId, owner, scope, input.provider);
        if (input.action === "cancel")
          return authFlows.cancel(input.flowId, owner, scope, input.provider);
        if (input.action === "complete")
          return authFlows.complete(
            input.flowId,
            owner,
            scope,
            input.provider,
            input.callbackUrl ?? "",
          );
        const readConnection = async () => {
          const status = decodeAuthOverview(
            await runPromise(authRequest(input, target, "auth.v1.status", {})),
          );
          const connection = status.connections.find((entry) => entry.provider === input.provider);
          if (!connection?.supportsInteractiveLogin)
            throw new Error("This connection uses credentials managed by the host configuration.");
          return connection;
        };
        if (input.action === "start") {
          let connection: MeerkatAuthConnection | undefined;
          const request: NonNullable<ProviderInstance["meerkatControls"]>["request"] = (
            method,
            requestParams,
          ) => {
            if (!connection)
              return Promise.reject(new Error("Sign-in account check is incomplete."));
            return runPromise(authRequest(input, target, method, requestParams, connection));
          };
          return authFlows.start(
            owner,
            scope,
            input.provider,
            request,
            params,
            () => runPromise(refreshAccountProjection(input, target)),
            cancellationScope,
            async () => {
              connection = await readConnection();
            },
          );
        }
        return authFlows.runLogout(cancellationScope, input.provider, async () => {
          await readConnection();
          await runPromise(
            authRequest(input, target, "auth.v1.logout", { provider: input.provider }),
          );
          return {
            flowId: null,
            authorizeUrl: null,
            status: "disconnected" as const,
            message: "Signed out.",
          };
        });
      },
      catch: (cause) => failure(input, cause),
    });
    if (result.status === "connected" || result.status === "disconnected") {
      // A later status request can recover a failed projection refresh, but its
      // failure does not undo the native sign-in or sign-out receipt.
      yield* refreshAccountProjection(input, target).pipe(
        Effect.catchCause(() =>
          Effect.logWarning(
            "Provider account changed, but model availability could not be refreshed",
            {
              instanceId: input.instanceId,
              projectId: input.projectId,
            },
          ),
        ),
      );
    }
    return result;
  });
  return { questions, answer, approvals, decideApproval, authStatus, authAction };
});
