import {
  IsoDateTime,
  ProjectId,
  SourceControlCloneRepositoryInput,
  SourceControlRepositoryError,
  TrimmedNonEmptyString,
  type ProjectCloneStartInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { SourceControlPreparedClone } from "../sourceControl/SourceControlRepositoryService.ts";

/** Unresolved clone ownership, not a second project or live-progress record. */
export const ProjectCloneIntent = Schema.Struct({
  projectId: ProjectId,
  destinationPath: TrimmedNonEmptyString,
  remoteUrl: TrimmedNonEmptyString,
  phase: Schema.Literals(["running", "failed", "cancelled"]),
  startedAt: IsoDateTime,
  endedAt: Schema.NullOr(IsoDateTime),
  retryInput: Schema.NullOr(SourceControlCloneRepositoryInput),
});
export type ProjectCloneIntent = typeof ProjectCloneIntent.Type;

/** Persist only an address that is safe to display, never URL credentials. */
function credentialFreeRemoteUrl(remoteUrl: string): string | null {
  try {
    const url = new URL(remoteUrl);
    if (url.username || url.password || url.search || url.hash) {
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      return url.toString();
    }
  } catch {
    // A malformed URL can still contain credentials (for example, a bad
    // port after userinfo). Do not guess where its authority or secrets end.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(remoteUrl)) return null;
    // The conventional SSH username is public; an arbitrary one may be a token.
    if (!remoteUrl.startsWith("git@")) {
      return remoteUrl.replace(/^[^/]+@(?=[^/:]+:)/, "");
    }
  }
  return remoteUrl;
}

export function makeProjectCloneIntent(
  input: ProjectCloneStartInput,
  prepared: SourceControlPreparedClone,
  startedAt: string,
): ProjectCloneIntent {
  const safeRemoteUrl = credentialFreeRemoteUrl(prepared.remoteUrl);
  const remoteUrl = safeRemoteUrl ?? "Repository URL not saved";
  const repositoryUrl = prepared.repository
    ? credentialFreeRemoteUrl(prepared.repository.url)
    : null;
  const retryInput =
    input.provider && input.repository && prepared.repository
      ? repositoryUrl === null
        ? null
        : {
            provider: input.provider,
            repository: repositoryUrl,
            destinationPath: prepared.destinationPath,
            ...(input.protocol ? { protocol: input.protocol } : {}),
          }
      : safeRemoteUrl !== null && safeRemoteUrl === prepared.cloneUrl
        ? { remoteUrl, destinationPath: prepared.destinationPath }
        : null;
  return {
    projectId: input.projectId,
    destinationPath: prepared.destinationPath,
    remoteUrl,
    phase: "running",
    startedAt,
    endedAt: null,
    retryInput,
  };
}

export class ProjectCloneIntentStore extends Context.Service<
  ProjectCloneIntentStore,
  {
    readonly list: Effect.Effect<ReadonlyArray<ProjectCloneIntent>, SourceControlRepositoryError>;
    readonly put: (intent: ProjectCloneIntent) => Effect.Effect<void, SourceControlRepositoryError>;
    readonly remove: (projectId: ProjectId) => Effect.Effect<void, SourceControlRepositoryError>;
  }
>()("t3/project/ProjectCloneIntentStore") {}

const IntentJson = Schema.fromJsonString(ProjectCloneIntent);
const encodeIntent = Schema.encodeEffect(IntentJson);
const decodeIntent = Schema.decodeEffect(IntentJson);

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const failure = (operation: string) => (cause: unknown) =>
    new SourceControlRepositoryError({
      provider: "unknown",
      operation,
      detail:
        "The repository clone recovery state could not be read or saved. Retry the operation.",
      cause,
    });
  return ProjectCloneIntentStore.of({
    list: Effect.gen(function* () {
      // Project events and their projections commit in one transaction. An
      // absent project means creation never committed, or deletion already did.
      yield* sql`DELETE FROM project_clone_intents WHERE NOT EXISTS (
        SELECT 1 FROM projection_projects p
        WHERE p.project_id = project_clone_intents.project_id AND p.deleted_at IS NULL
      )`;
      const rows = yield* sql<{
        readonly intent_json: string;
      }>`SELECT intent_json FROM project_clone_intents`;
      return yield* Effect.forEach(rows, (row) => decodeIntent(row.intent_json));
    }).pipe(Effect.mapError(failure("loadCloneRecovery"))),
    put: (intent) =>
      encodeIntent(intent).pipe(
        Effect.flatMap(
          (json) => sql`INSERT INTO project_clone_intents (project_id, intent_json)
          VALUES (${intent.projectId}, ${json})
          ON CONFLICT (project_id) DO UPDATE SET intent_json = excluded.intent_json`,
        ),
        Effect.asVoid,
        Effect.mapError(failure("saveCloneRecovery")),
      ),
    remove: (projectId) =>
      sql`DELETE FROM project_clone_intents WHERE project_id = ${projectId}`.pipe(
        Effect.asVoid,
        Effect.mapError(failure("removeCloneRecovery")),
      ),
  });
});

export const layer = Layer.effect(ProjectCloneIntentStore, make);
