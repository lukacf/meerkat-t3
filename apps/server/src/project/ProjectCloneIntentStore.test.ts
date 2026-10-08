import { expect, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { make, makeProjectCloneIntent } from "./ProjectCloneIntentStore.ts";

const projectId = ProjectId.make("durable-clone");
const input = {
  projectId,
  title: "Fixture",
  createdAt: "2026-10-04T00:00:00.000Z",
  destinationPath: "/fixture/clone",
  remoteUrl: "/fixture/remote.git",
};
const prepared = {
  destinationPath: input.destinationPath,
  remoteUrl: input.remoteUrl,
  cloneUrl: input.remoteUrl,
  repository: null,
};
const intent = makeProjectCloneIntent(input, prepared, input.createdAt);

const createProject = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects (
    project_id, title, workspace_root, scripts_json, created_at, updated_at
  ) VALUES (${projectId}, ${input.title}, ${input.destinationPath}, '[]',
    ${input.createdAt}, ${input.createdAt})`;
});

it.effect("loads unresolved intent in a fresh store instance and removes it after success", () =>
  Effect.gen(function* () {
    const first = yield* make;
    yield* first.put(intent);
    yield* createProject;
    const restarted = yield* make;
    expect(yield* restarted.list).toEqual([intent]);
    yield* restarted.put({ ...intent, phase: "cancelled", endedAt: input.createdAt });
    expect((yield* first.list)[0]?.phase).toBe("cancelled");
    yield* restarted.remove(projectId);
    expect(yield* first.list).toEqual([]);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("drops only orphaned or deleted project intents during hydration", () =>
  Effect.gen(function* () {
    const store = yield* make;
    yield* store.put(intent);
    expect(yield* store.list).toEqual([]);
    yield* createProject;
    yield* store.put(intent);
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE projection_projects SET deleted_at = ${input.createdAt}
      WHERE project_id = ${projectId}`;
    expect(yield* store.list).toEqual([]);
    const rows = yield* sql`SELECT project_id FROM project_clone_intents`;
    expect(rows).toHaveLength(0);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("fails hydration on corrupt intent instead of exposing its project as ready", () =>
  Effect.gen(function* () {
    yield* createProject;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO project_clone_intents (project_id, intent_json)
      VALUES (${projectId}, '{broken')`;
    const store = yield* make;
    const error = yield* store.list.pipe(Effect.flip);
    expect(error.operation).toBe("loadCloneRecovery");
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it("keeps credential-bearing URLs and private provider metadata out of durable intent", () => {
  const secret =
    "https://user:private-token@github.com/owner/repo.git?key=query-secret#fragment-secret";
  const saved = makeProjectCloneIntent(
    { ...input, remoteUrl: secret },
    {
      ...prepared,
      remoteUrl: "https://github.com/owner/repo.git#fragment-secret",
      cloneUrl: secret,
    },
    input.createdAt,
  );
  expect(saved.remoteUrl).toBe("https://github.com/owner/repo.git");
  expect(saved.retryInput).toBeNull();
  expect(JSON.stringify(saved)).not.toMatch(/private-token|query-secret|fragment-secret|user:/);

  const providerIntent = makeProjectCloneIntent(
    {
      ...input,
      provider: "github",
      repository: "owner/repo",
      protocol: "https",
    },
    {
      ...prepared,
      remoteUrl: "https://github.com/owner/repo.git",
      cloneUrl: secret,
      repository: {
        provider: "github",
        nameWithOwner: "owner/repo",
        url: secret,
        sshUrl: secret,
      },
    },
    input.createdAt,
  );
  expect(providerIntent.retryInput).toEqual({
    provider: "github",
    repository: "https://github.com/owner/repo.git",
    protocol: "https",
    destinationPath: input.destinationPath,
  });
  expect(JSON.stringify(providerIntent)).not.toMatch(
    /private-token|query-secret|fragment-secret|user:/,
  );
});

it("preserves an enterprise host when re-resolving a provider repository after restart", () => {
  const saved = makeProjectCloneIntent(
    {
      ...input,
      provider: "github",
      repository: "https://git.example.test/team/tool",
      protocol: "ssh",
    },
    {
      ...prepared,
      remoteUrl: "git@git.example.test:team/tool.git",
      cloneUrl: "git@git.example.test:team/tool.git",
      repository: {
        provider: "github",
        nameWithOwner: "team/tool",
        url: "https://git.example.test/team/tool.git",
        sshUrl: "git@git.example.test:team/tool.git",
      },
    },
    input.createdAt,
  );
  expect(saved.retryInput).toEqual({
    provider: "github",
    repository: "https://git.example.test/team/tool.git",
    destinationPath: input.destinationPath,
    protocol: "ssh",
  });
});

for (const malformedUrl of [
  "https://user:private-token@example.test:badport/repo?key=query-secret#fragment-secret",
  "https://user:private-token@[invalid-host/repo",
]) {
  it(`does not persist credentials from a malformed URL: ${malformedUrl.includes("badport") ? "port" : "host"}`, () => {
    const saved = makeProjectCloneIntent(
      { ...input, remoteUrl: malformedUrl },
      { ...prepared, remoteUrl: malformedUrl, cloneUrl: malformedUrl },
      input.createdAt,
    );
    expect(saved.remoteUrl).toBe("Repository URL not saved");
    expect(saved.retryInput).toBeNull();
    expect(JSON.stringify(saved)).not.toMatch(/private-token|query-secret|fragment-secret|user:/);

    const providerSaved = makeProjectCloneIntent(
      { ...input, provider: "github", repository: "owner/repo" },
      {
        ...prepared,
        remoteUrl: malformedUrl,
        cloneUrl: malformedUrl,
        repository: {
          provider: "github",
          nameWithOwner: "owner/repo",
          url: malformedUrl,
          sshUrl: malformedUrl,
        },
      },
      input.createdAt,
    );
    expect(providerSaved.retryInput).toBeNull();
    expect(JSON.stringify(providerSaved)).not.toMatch(
      /private-token|query-secret|fragment-secret|user:/,
    );
  });
}

for (const remoteUrl of ["/local/team@name/repo.git", "git@git.example.test:team/repo.git"]) {
  it(`preserves a credential-free clone source: ${remoteUrl}`, () => {
    const saved = makeProjectCloneIntent(
      { ...input, remoteUrl },
      { ...prepared, remoteUrl, cloneUrl: remoteUrl },
      input.createdAt,
    );
    expect(saved.remoteUrl).toBe(remoteUrl);
    expect(saved.retryInput).toEqual({ remoteUrl, destinationPath: input.destinationPath });
  });
}
