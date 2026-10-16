import {
  MeerkatAuthOverview,
  MeerkatAuthConnection,
  MeerkatAuthDefaultActivation,
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
const decodeCheckedConnection = Schema.decodeUnknownSync(
  Schema.Struct({ checked: Schema.Literal(true), connection: MeerkatAuthConnection }),
);
const decodeConfiguredConnection = Schema.decodeUnknownSync(
  Schema.Struct({
    connection: MeerkatAuthConnection,
    defaultActivation: Schema.optional(MeerkatAuthDefaultActivation),
    credentialsSaved: Schema.optional(Schema.Boolean),
  }),
);
const decodeClearedCredentials = Schema.decodeUnknownSync(
  Schema.Struct({ cleared: Schema.Literal(true) }),
);
const decodeDeletedAccount = Schema.decodeUnknownSync(
  Schema.Struct({ deleted: Schema.Literal(true) }),
);
const decodeDefaultAccount = Schema.decodeUnknownSync(
  Schema.Struct({ updated: Schema.Literal(true) }),
);
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
  const failure = (input: { readonly projectId?: MeerkatAuthScope["projectId"] }, cause: unknown) =>
    new MeerkatControlError({
      ...(input.projectId ? { projectId: input.projectId } : {}),
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
    if (!input.projectId) {
      if (input.threadTarget)
        return yield* failure(input, "A conversation account requires its project.");
      const instance = yield* registry.getInstance(input.instanceId);
      if (!instance?.enabled || instance.driverKind !== "meerkat" || !instance.meerkatControls)
        return yield* failure(input, "Accounts are unavailable. Reconnect this computer.");
      return {
        instance,
        request: instance.meerkatControls.request,
        projectRoot: undefined,
        params: {} as { projectPath?: string; stateRoot?: string },
      };
    }
    const target = yield* provider({ ...input, projectId: input.projectId });
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
    const request = Effect.gen(function* () {
      let current = yield* currentAuthTarget(input, original);
      if ((method === "auth.v1.loginComplete" || method === "auth.v1.devicePoll") && connection) {
        const overview = yield* Effect.tryPromise({
          try: async () =>
            decodeAuthOverview(await current.request("auth.v1.status", current.params)),
          catch: (cause) => failure(input, cause),
        });
        const resolved = overview.connections.find(
          (entry) =>
            entry.provider === connection.provider &&
            entry.realmId === connection.realmId &&
            entry.bindingId === connection.bindingId &&
            entry.profileId === connection.profileId,
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
    });
    return yield* original.params.projectPath
      ? withWorkspaceLease(original.params.projectPath, request)
      : request;
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
      ...(input.projectId && target.params.projectPath
        ? {
            workspace: {
              projectId: input.projectId,
              ...(input.threadTarget ? { threadId: input.threadTarget.threadId } : {}),
              cwd: target.params.projectPath,
            },
          }
        : {}),
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
    if (target.params.projectPath) {
      yield* providerSnapshots.refreshWorkspaceSnapshot({
        instanceId: input.instanceId,
        cwd: target.params.projectPath,
        invalidate: true,
      });
    }
    yield* currentAuthTarget(input, original);
    yield* providerSnapshots.refreshInstance(
      input.instanceId,
      target.params.projectPath ? undefined : { invalidateWorkspaces: true },
    );
  });
  const authAction = Effect.fn("MeerkatControls.authAction")(function* (
    input: MeerkatAuthActionInput,
    owner: string,
  ) {
    const target = yield* authTarget(input);
    const identityValues = [input.realmId, input.bindingId, input.profileId];
    if (identityValues.some(Boolean) && !identityValues.every(Boolean))
      return yield* failure(input, "Choose the complete account identity before changing it.");
    const identity =
      input.realmId && input.bindingId && input.profileId
        ? { realmId: input.realmId, bindingId: input.bindingId, profileId: input.profileId }
        : undefined;
    if (input.action !== "configure" && !identity)
      return yield* failure(
        input,
        "Choose the account to change. Refresh accounts if it is missing.",
      );
    const accountScope = identity
      ? [identity.realmId, identity.bindingId, identity.profileId].map(encodeURIComponent).join(":")
      : "provider-default";
    const cancellationScope = `${input.instanceId}:${target.params.stateRoot ?? "global"}:instance:${authInstanceId(target.instance)}:${accountScope}`;
    const scope = `${cancellationScope}${input.threadTarget ? `:thread:${input.threadTarget.threadId}` : ""}`;
    const result = yield* Effect.tryPromise({
      try: async () => {
        if (input.action === "status")
          return authFlows.status(input.flowId, owner, scope, input.provider);
        if (input.action === "devicePoll")
          return authFlows.pollDevice(input.flowId, owner, scope, input.provider);
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
        if (input.action === "configure") {
          if ((input.projectId || input.threadTarget) && !identity)
            throw new Error("Add accounts from this computer's account settings.");
          const overview = decodeAuthOverview(
            await runPromise(authRequest(input, target, "auth.v1.status", {})),
          );
          const method = overview.methods?.find(
            (entry) => entry.id === input.methodId && entry.provider === input.provider,
          );
          if (!method) throw new Error("This sign-in method is unavailable. Refresh accounts.");
          if ((input.projectId || input.threadTarget) && method.flow !== "secret")
            throw new Error("Configure sign-in accounts from this computer's account settings.");
          const existing = identity
            ? overview.connections.find(
                (entry) =>
                  entry.realmId === identity.realmId &&
                  entry.bindingId === identity.bindingId &&
                  entry.profileId === identity.profileId &&
                  entry.provider === input.provider,
              )
            : undefined;
          if (identity && !existing)
            throw new Error("This account is no longer available. Refresh accounts.");
          if (existing && (existing.editable === false || existing.supportsSecretUpdate === false))
            throw new Error("This account's credentials are managed by its configuration owner.");
          const fields = input.fields ?? {};
          if (Object.keys(fields).some((key) => !method.fields.some((field) => field.key === key)))
            throw new Error("The account contains unsupported configuration fields.");
          if (
            method.fields.some(
              (field) =>
                field.required && !(fields[field.key] ?? existing?.fields?.[field.key])?.trim(),
            )
          )
            throw new Error("Complete the required account fields.");
          if (method.flow === "secret" && !input.secret?.trim())
            throw new Error(
              `${method.secretLabel ?? "Credential"} is required to save this account.`,
            );
          const configured = decodeConfiguredConnection(
            await runPromise(
              authRequest(input, target, "auth.v1.configure", {
                methodId: method.id,
                fields,
                ...identity,
                ...(input.secret !== undefined ? { secret: input.secret } : {}),
              }),
            ),
          );
          return {
            flowId: null,
            authorizeUrl: null,
            status:
              configured.connection.state === "connected"
                ? ("connected" as const)
                : ("disconnected" as const),
            message:
              configured.connection.state === "connected"
                ? configured.defaultActivation?.status === "needs_selection"
                  ? "Credentials saved. Choose a default account in Providers to use its models."
                  : "Credentials saved."
                : configured.credentialsSaved
                  ? "Credentials saved. Refresh account status to check the connection."
                  : "Account configured. Continue sign-in.",
            connection: configured.connection,
            ...(configured.defaultActivation
              ? { defaultActivation: configured.defaultActivation }
              : {}),
            ...(configured.credentialsSaved !== undefined
              ? { credentialsSaved: configured.credentialsSaved }
              : {}),
          };
        }
        const readConnection = async () => {
          const overview = decodeAuthOverview(
            await runPromise(authRequest(input, target, "auth.v1.status", {})),
          );
          const matches = overview.connections.filter(
            (entry) =>
              entry.provider === input.provider &&
              (!identity ||
                (entry.realmId === identity.realmId &&
                  entry.bindingId === identity.bindingId &&
                  entry.profileId === identity.profileId)),
          );
          if (matches.length !== 1)
            throw new Error("Choose the account to change. Refresh accounts if it is missing.");
          return { connection: matches[0]!, methods: overview.methods ?? [] };
        };
        if (input.action === "check") {
          const { connection } = await readConnection();
          if (connection.editable !== true)
            throw new Error("This account's credentials are managed by its configuration owner.");
          const checked = decodeCheckedConnection(
            await runPromise(
              authRequest(input, target, "auth.v1.check", {
                provider: input.provider,
                ...identity,
              }),
            ),
          );
          if (
            checked.connection.provider !== connection.provider ||
            checked.connection.realmId !== connection.realmId ||
            checked.connection.bindingId !== connection.bindingId ||
            checked.connection.profileId !== connection.profileId
          )
            throw new Error("The credential check returned a different account. Refresh accounts.");
          return {
            flowId: null,
            authorizeUrl: null,
            status:
              checked.connection.state === "connected"
                ? ("connected" as const)
                : ("disconnected" as const),
            message: null,
            connection: checked.connection,
          };
        }
        if (input.action === "start" || input.action === "deviceStart") {
          let connection: MeerkatAuthConnection | undefined;
          const params: Record<string, unknown> = { ...target.params };
          const request: NonNullable<ProviderInstance["meerkatControls"]>["request"] = (
            method,
            requestParams,
          ) => {
            if (!connection)
              return Promise.reject(new Error("Sign-in account check is incomplete."));
            return runPromise(authRequest(input, target, method, requestParams, connection));
          };
          const start = input.action === "deviceStart" ? authFlows.startDevice : authFlows.start;
          return start(
            owner,
            scope,
            input.provider,
            request,
            params,
            () => runPromise(refreshAccountProjection(input, target)),
            cancellationScope,
            async () => {
              const account = await readConnection();
              connection = account.connection;
              if (!connection.supportsInteractiveLogin || connection.editable === false)
                throw new Error(
                  "This account's credentials are managed by its configuration owner.",
                );
              if (input.action === "deviceStart" && connection.loginFlow !== "device")
                throw new Error("This account does not support device-code sign-in.");
              if (input.action === "start" && connection.loginFlow === "device")
                throw new Error("Use device-code sign-in for this account.");
              Object.assign(params, {
                realmId: connection.realmId,
                bindingId: connection.bindingId,
                profileId: connection.profileId,
              });
              if (input.action === "start") {
                const methods = account.methods.filter(
                  (method) =>
                    method.provider === connection!.provider &&
                    method.authMethod === connection!.authMethod &&
                    method.backendKind === connection!.backendKind &&
                    method.flow === "browser",
                );
                if (methods.length !== 1 || !methods[0]!.callback)
                  throw new Error(
                    "The account's sign-in callback is unavailable. Update the app and try again.",
                  );
                return methods[0]!.callback;
              }
            },
          );
        }
        return authFlows.runLogout(cancellationScope, input.provider, async () => {
          const { connection } = await readConnection();
          if (connection.editable === false)
            throw new Error("This account is managed by its configuration owner.");
          if (input.action === "default" && connection.supportsDefault === false)
            throw new Error("This account cannot be set as the default here.");
          if (input.action === "delete" && connection.supportsRemoval !== true)
            throw new Error("This account cannot be removed here.");
          const method =
            input.action === "delete"
              ? "auth.v1.delete"
              : input.action === "default"
                ? "auth.v1.default"
                : "auth.v1.logout";
          const receipt = await runPromise(
            authRequest(input, target, method, {
              provider: input.provider,
              realmId: connection.realmId,
              bindingId: connection.bindingId,
              profileId: connection.profileId,
            }),
          );
          if (input.action === "default") decodeDefaultAccount(receipt);
          else if (input.action === "delete") decodeDeletedAccount(receipt);
          else decodeClearedCredentials(receipt);
          return {
            flowId: null,
            authorizeUrl: null,
            status:
              input.action === "default" && connection.state === "connected"
                ? ("connected" as const)
                : ("disconnected" as const),
            message:
              input.action === "delete"
                ? "Account removed."
                : input.action === "default"
                  ? "Default account updated."
                  : "Signed out.",
          };
        });
      },
      catch: (cause) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        const secrets = [input.secret, ...Object.values(input.fields ?? {})].filter(
          (value): value is string => Boolean(value),
        );
        return failure(
          input,
          secrets.reduce((safe, secret) => safe.replaceAll(secret, "[redacted]"), message),
        );
      },
    });
    if (result.status === "connected" || result.status === "disconnected") {
      yield* refreshAccountProjection(input, target).pipe(
        Effect.catchCause(() =>
          Effect.logWarning("Account changed, but model availability could not be refreshed", {
            instanceId: input.instanceId,
            projectId: input.projectId,
          }),
        ),
      );
    }
    return result;
  });
  return { questions, answer, approvals, decideApproval, authStatus, authAction };
});
