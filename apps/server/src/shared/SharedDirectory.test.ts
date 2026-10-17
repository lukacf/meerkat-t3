import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  SharedProjectPage,
  SharedSpecialistPage,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeSharedWorkspaceStore } from "./SharedWorkspaceStore.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const isProjectPage = Schema.is(SharedProjectPage);
const isSpecialistPage = Schema.is(SharedSpecialistPage);

const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(SqlitePersistenceMemory));
const fixture = Effect.gen(function* () {
  const store = yield* makeSharedWorkspaceStore;
  yield* store.configure({ name: "Directory" });
  return store;
});
const projectInput = (
  index: number,
  repository = `https://example.test/teams/project-${index}`,
) => ({
  requestId: `project-${index}`,
  name: `Project ${index}`,
  repository,
  hostProjectId: ProjectId.make(`host-${index}`),
});

describe("bounded shared directory", () => {
  it.effect(
    "retains long canonical remotes consistently in directory reads and checkout mappings",
    () =>
      run(
        Effect.gen(function* () {
          const store = yield* fixture;
          const repository = `https://example.test/teams/${"nested/".repeat(60)}repository`;
          const value = yield* store.registerProject({
            ...projectInput(1, repository),
            aliases: [repository.replace("example.test", "mirror.test")],
          });
          expect(value.repository.length).toBeGreaterThan(200);
          expect(yield* store.project(value.sharedProjectId)).toEqual(value);
          yield* store.join("client", { displayName: "Ada" });
          const checkout = yield* store.attachCheckout("client", {
            localEnvironmentId: EnvironmentId.make("local"),
            localProjectId: ProjectId.make("local-project"),
            repository,
          });
          const snapshot = yield* store.snapshot("client");
          expect(snapshot.projects).toEqual([value]);
          expect(snapshot.checkouts).toEqual([checkout]);
          expect(
            (yield* store
              .registerProject({
                ...projectInput(2),
                aliases: [`https://example.test/team/${"a".repeat(2048)}`],
              })
              .pipe(Effect.flip)).code,
          ).toBe("invalid_input");
          expect((yield* store.snapshot("client")).projects).toEqual([value]);
        }),
      ),
  );

  it.effect("pages a large directory by stable IDs within the native response budget", () =>
    run(
      Effect.gen(function* () {
        const store = yield* fixture;
        for (let index = 0; index < 95; index++) {
          yield* store.registerProject({
            ...projectInput(index, `https://example.test/team/${"a".repeat(1960)}-${index}`),
            name: "p".repeat(200),
          });
        }
        const all: string[] = [];
        let after: string | undefined;
        let pageCount = 0;
        do {
          const page = yield* store.listProjects({ limit: 100, ...(after ? { after } : {}) });
          expect(isProjectPage(page)).toBe(true);
          expect(Buffer.byteLength(encode(page))).toBeLessThanOrEqual(192 * 1024);
          expect(page.items.length).toBeGreaterThan(0);
          all.push(...page.items.map((item) => item.sharedProjectId));
          after = page.nextCursor ?? undefined;
          pageCount++;
        } while (after && pageCount < 4);
        expect(pageCount).toBe(2);
        expect(all).toHaveLength(95);
        expect(new Set(all).size).toBe(95);
        expect(all).toEqual([...all].sort());
        expect((yield* store.listProjects({ limit: 0 }).pipe(Effect.flip)).code).toBe(
          "invalid_input",
        );
      }),
    ),
  );

  it.effect("keeps specialist lists concise and rejects oversized details atomically", () =>
    run(
      Effect.gen(function* () {
        const store = yield* fixture;
        const projects = [];
        for (let index = 0; index < 5; index++)
          projects.push(yield* store.registerProject(projectInput(index)));
        const input = {
          requestId: "specialist",
          label: "API specialist",
          nativeTarget: {
            projectId: ProjectId.make("host-0"),
            instanceId: ProviderInstanceId.make("meerkat"),
            agentId: "native-api",
          },
          assignments: projects.map((project) => ({
            sharedProjectId: project.sharedProjectId,
            charter: "x".repeat(32_768),
            paths: [],
            tags: [],
          })),
        };
        expect((yield* store.registerSpecialist(input).pipe(Effect.flip)).code).toBe(
          "limit_exceeded",
        );
        expect((yield* store.listSpecialists({})).items).toEqual([]);
        const specialist = yield* store.registerSpecialist({
          ...input,
          assignments: input.assignments.slice(0, 3),
        });
        const second = yield* store.registerSpecialist({
          ...input,
          requestId: "second",
          nativeTarget: { ...input.nativeTarget, agentId: "native-api-2" },
          assignments: input.assignments.slice(0, 1),
        });
        const page = yield* store.listSpecialists({ limit: 1 });
        const next = yield* store.listSpecialists({ after: page.nextCursor!, limit: 1 });
        expect(isSpecialistPage(page)).toBe(true);
        expect(page.items).toHaveLength(1);
        expect(next.nextCursor).toBeNull();
        expect([...page.items, ...next.items].map((item) => item.specialistId).sort()).toEqual(
          [specialist.specialistId, second.specialistId].sort(),
        );
        expect(encode(page)).not.toContain("charter");
        const detail = yield* store.specialist(specialist.specialistId);
        expect(detail).toEqual(specialist);
        expect(Buffer.byteLength(encode({ content: detail }))).toBeLessThan(256 * 1024);
        expect((yield* store.specialist("missing").pipe(Effect.flip)).code).toBe("not_found");
      }),
    ),
  );
});
