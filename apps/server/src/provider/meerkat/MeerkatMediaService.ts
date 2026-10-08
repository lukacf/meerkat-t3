import {
  MeerkatBrowserGrant,
  type MeerkatBrowserGrantInput,
  MeerkatImageRead,
  MeerkatImageUpload,
  MeerkatMediaError,
  type MeerkatMediaTarget,
  type MeerkatImageUploadInput,
  type MeerkatImageReadInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { readMcpProviderSession } from "../../mcp/McpProviderSession.ts";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { meerkatProjectStateRoot } from "../Layers/MeerkatAdapter.ts";
import { makeMeerkatObservedAgents } from "./MeerkatObservedAgents.ts";
import type { makeMeerkatTeamService } from "./MeerkatTeamService.ts";

export const makeMeerkatMediaService = Effect.fn("makeMeerkatMediaService")(function* (
  team: Pick<Effect.Success<typeof makeMeerkatTeamService>, "interactionTarget">,
) {
  const registry = yield* ProviderInstanceRegistry;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  const settings = yield* ServerSettingsService;
  const environment = yield* ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;
  const observed = yield* makeMeerkatObservedAgents;
  const browserGate = yield* Semaphore.make(1);
  const failure = (input: MeerkatMediaTarget, cause: unknown) =>
    new MeerkatMediaError({
      projectId: input.projectId,
      message: cause instanceof Error ? cause.message : String(cause),
    });
  const target = Effect.fn("MeerkatMedia.target")(function* (
    input: MeerkatMediaTarget,
    readOnly = false,
  ) {
    if (Boolean(input.agentRef) === Boolean(input.threadId))
      return yield* failure(input, "Choose exactly one agent or thread.");
    const instance = yield* registry.getInstance(input.instanceId);
    if (!instance?.enabled || !instance.meerkatMedia)
      return yield* failure(input, "This Meerkat connection is unavailable.");
    if (readOnly && instance.meerkatTeam) {
      const saved = (yield* observed
        .list(input.projectId, input.instanceId, input.agentRef)
        .pipe(Effect.mapError((cause) => failure(input, cause)))).find(
        (entry) =>
          input.agentRef ||
          (entry.agent.threadId === input.threadId &&
            entry.agent.record.runtime_member_id === "ingress" &&
            !entry.agent.record.labels.source_mob_id),
      );
      if (saved) {
        if (saved.provider_state_root !== instance.meerkatTeam.stateRoot)
          return yield* failure(
            input,
            "The original native provider is required to read this image.",
          );
        return {
          request: instance.meerkatMedia.request,
          instance,
          sessionId: saved.agent.record.session_id,
          params: {
            projectPath: saved.project_path,
            stateRoot:
              saved.state_root ??
              meerkatProjectStateRoot(path, saved.provider_state_root, saved.project_path),
            mobId: saved.agent.mobId,
          },
        };
      }
    }
    const resolved = yield* team
      .interactionTarget({
        projectId: input.projectId,
        instanceId: input.instanceId,
        ...(input.agentRef ? { agentRef: input.agentRef } : {}),
        ...(input.threadId ? { threadId: input.threadId } : {}),
      })
      .pipe(Effect.mapError((cause) => failure(input, cause)));
    const record = resolved.record;
    return {
      request: instance.meerkatMedia.request,
      instance,
      sessionId: record.session_id,
      params: {
        projectPath: resolved.projectPath,
        stateRoot:
          resolved.stateRoot ??
          meerkatProjectStateRoot(path, resolved.reader.stateRoot, resolved.projectPath),
        mobId: resolved.mobId,
        expected: {
          identity: record.identity,
          runtimeKey: record.runtime_key,
          runtimeMemberId: record.runtime_member_id,
          sessionId: record.session_id ?? null,
          sourceMobId: record.labels.source_mob_id ?? null,
        },
      },
    };
  });
  const imageUpload = Effect.fn("MeerkatMedia.imageUpload")(function* (
    input: MeerkatImageUploadInput,
  ) {
    const { request, params } = yield* target(input);
    return yield* Effect.tryPromise({
      try: async () =>
        await request("mobs.v1.imageUpload", {
          ...params,
          mediaType: input.mediaType,
          dataBase64: input.dataBase64,
        }),
      catch: (cause) => failure(input, cause),
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(MeerkatImageUpload)),
      Effect.mapError((cause) => failure(input, cause)),
    );
  });
  const imageRead = Effect.fn("MeerkatMedia.imageRead")(function* (
    input: typeof MeerkatImageReadInput.Type,
  ) {
    const { request, params } = yield* target(input, true);
    return yield* Effect.tryPromise({
      try: async () => await request("mobs.v1.imageRead", { ...params, blobId: input.blobId }),
      catch: (cause) => failure(input, cause),
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(MeerkatImageRead)),
      Effect.mapError((cause) => failure(input, cause)),
    );
  });
  const browserAllowed = (input: MeerkatMediaTarget) =>
    settings.getSettings.pipe(
      Effect.map(
        (value) => resolveProjectSettings(value, input.projectId).settings.enableAgentBrowserAccess,
      ),
      Effect.mapError((cause) => failure(input, cause)),
    );
  const browserStatus = Effect.fn("MeerkatMedia.browserStatus")(function* (
    input: MeerkatMediaTarget,
  ) {
    const { request, params } = yield* target(input);
    if (!(yield* browserAllowed(input)))
      return {
        enabled: false,
        reason: "disabled" as const,
        message:
          "Agent browser access is off for this project. Enable it in project settings, then reconnect the browser workspace.",
      };
    const status = yield* Effect.tryPromise({
      try: async () => await request("mobs.v1.browserStatus", params),
      catch: (cause) => failure(input, cause),
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(MeerkatBrowserGrant)),
      Effect.mapError((cause) => failure(input, cause)),
    );
    if (!status.enabled) return status;
    const host = status.hostThreadId ?? input.threadId;
    const session = host ? readMcpProviderSession(host) : undefined;
    if (
      !session ||
      session.environmentId !== environmentId ||
      session.providerInstanceId !== input.instanceId ||
      !session.capabilities.has("preview") ||
      status.hostSessionId !== session.providerSessionId
    )
      return {
        ...status,
        enabled: false,
        reason: "expired" as const,
        message:
          "This browser connection has expired. Open its thread in the desktop app and share again.",
      };
    return status;
  });
  const browserGrant = Effect.fn("MeerkatMedia.browserGrant")(function* (
    input: MeerkatBrowserGrantInput,
  ) {
    const resolved = yield* target(input);
    const { request, params } = resolved;
    const configure = (extra: Record<string, unknown>) =>
      Effect.tryPromise({
        try: async () => await request("mobs.v1.browserConfigure", { ...params, ...extra }),
        catch: (cause) => failure(input, cause),
      }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(MeerkatBrowserGrant)),
        Effect.mapError((cause) => failure(input, cause)),
      );
    if (!input.enabled) return yield* configure({ enabled: false });
    const hostThreadId = input.hostThreadId ?? input.threadId;
    if (!hostThreadId) return yield* failure(input, "Choose a thread browser workspace.");
    if (!(yield* browserAllowed(input)))
      return {
        enabled: false,
        reason: "disabled" as const,
        message:
          "Agent browser access is off for this project. Enable it in project settings first.",
      };
    const rows =
      yield* sql`SELECT t.project_id,COALESCE(t.worktree_path,p.workspace_root) AS workspace FROM projection_threads t JOIN projection_projects p ON p.project_id=t.project_id JOIN provider_session_runtime r ON r.thread_id=t.thread_id WHERE t.thread_id=${hostThreadId} AND t.deleted_at IS NULL AND p.deleted_at IS NULL AND r.provider_instance_id=${input.instanceId}`.pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Array(Schema.Struct({ project_id: Schema.String, workspace: Schema.String })),
          ),
        ),
        Effect.mapError((cause) => failure(input, cause)),
      );
    if (rows[0]?.project_id !== input.projectId)
      return yield* failure(
        input,
        "Choose a browser workspace in this project and provider connection.",
      );
    if (path.resolve(rows[0].workspace) !== path.resolve(params.projectPath))
      return {
        enabled: false,
        reason: "wrong-workspace" as const,
        message:
          "Choose a browser thread using this agent's checkout. Browser sharing stays within one workspace.",
      };
    const session = readMcpProviderSession(hostThreadId);
    if (
      !session ||
      session.environmentId !== environmentId ||
      session.providerInstanceId !== input.instanceId ||
      !session.capabilities.has("preview")
    )
      return {
        enabled: false,
        reason: "no-session" as const,
        message:
          "Open this thread in the desktop app and start or reconnect its agent session before sharing its browser.",
      };
    const result = yield* configure({
      enabled: true,
      hostThreadId,
      hostSessionId: session.providerSessionId,
      endpoint: session.endpoint,
      authorizationHeader: session.authorizationHeader,
    });
    const current = yield* target(input);
    if (
      readMcpProviderSession(hostThreadId) !== session ||
      current.instance !== resolved.instance ||
      current.sessionId !== resolved.sessionId ||
      current.params.projectPath !== params.projectPath ||
      current.params.stateRoot !== params.stateRoot ||
      current.params.mobId !== params.mobId
    ) {
      if (result.grantRevision !== undefined) {
        yield* configure({ enabled: false, expectedGrantRevision: result.grantRevision });
      }
      return yield* failure(
        input,
        "The browser or agent session changed while connecting. Refresh before sharing again.",
      );
    }
    return result;
  });
  return {
    imageUpload,
    imageRead,
    browserGrant: (input: MeerkatBrowserGrantInput) => browserGate.withPermit(browserGrant(input)),
    browserStatus,
  };
});
