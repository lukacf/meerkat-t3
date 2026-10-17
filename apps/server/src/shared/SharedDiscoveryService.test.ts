import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  SharedDiscoveryResult,
  type SharedSpecialistAssignment,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeSharedDiscoveryService } from "./SharedDiscoveryService.ts";
import { makeSharedWorkspaceStore } from "./SharedWorkspaceStore.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const isResult = Schema.is(SharedDiscoveryResult);
const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(SqlitePersistenceMemory));
const fixture = Effect.gen(function* () {
  const store = yield* makeSharedWorkspaceStore;
  yield* store.configure({
    name: "Discovery",
    limits: { maxSpecialists: 100, maxSnapshotBytes: 1024 },
  });
  const projects = yield* Effect.forEach(["catalog", "checkout", "shipping"], (name) =>
    store.registerProject({
      requestId: name,
      name,
      repository: `https://example.test/team/${name}`,
      hostProjectId: ProjectId.make(name),
    }),
  );
  const register = (label: string, assignments: ReadonlyArray<SharedSpecialistAssignment>) =>
    store.registerSpecialist({
      requestId: label,
      label,
      nativeTarget: {
        projectId: projects[0]!.hostProjectId,
        instanceId: ProviderInstanceId.make("meerkat"),
        agentId: label,
      },
      assignments,
    });
  const assignment = (
    index: number,
    overrides: Partial<SharedSpecialistAssignment> = {},
  ): SharedSpecialistAssignment => ({
    sharedProjectId: projects[index]!.sharedProjectId,
    charter: "Own the product domain and retain repository knowledge.",
    paths: [],
    tags: [],
    ...overrides,
  });
  return { store, projects, register, assignment, ...makeSharedDiscoveryService(store) };
});

describe("shared specialist discovery", () => {
  it.effect("finds literal ancestor and descendant paths without sibling or wildcard matches", () =>
    run(
      Effect.gen(function* () {
        const { register, assignment, discover } = yield* fixture;
        yield* register("Catalog", [assignment(0, { paths: ["src/catalog/"] })]);
        yield* register("Sibling", [assignment(0, { paths: ["src/catalogue"] })]);
        yield* register("Literal", [assignment(0, { paths: ["src/%_feature"] })]);
        yield* register("Wildcard lookalike", [assignment(0, { paths: ["src/other-feature"] })]);
        const child = yield* discover({ paths: ["src/catalog/items.ts"] });
        expect(child.items.map((item) => item.label)).toEqual(["Catalog"]);
        expect(child.items[0]!.matches[0]!.reasons).toEqual([
          { kind: "path", path: "src/catalog/" },
        ]);
        expect(
          (yield* discover({ paths: ["src/catalog"] })).items.map((item) => item.label),
        ).toEqual(["Catalog"]);
        expect((yield* discover({ paths: ["src"] })).items).toHaveLength(4);
        expect(
          (yield* discover({ paths: ["src/%_feature/handler.ts"] })).items.map(
            (item) => item.label,
          ),
        ).toEqual(["Literal"]);
        expect((yield* discover({ paths: ["src/catalog-other"] })).items).toEqual([]);
      }),
    ),
  );

  it.effect("matches tags exactly and accepts either path or tag relevance", () =>
    run(
      Effect.gen(function* () {
        const { register, assignment, discover } = yield* fixture;
        yield* register("Tagged", [assignment(0, { paths: ["src/other"], tags: ["API_%"] })]);
        yield* register("Wrong case", [assignment(0, { tags: ["api_%"] })]);
        yield* register("Substring", [assignment(0, { tags: ["API_%_extended"] })]);
        yield* register("Path", [assignment(0, { paths: ["src/catalog"] })]);
        const result = yield* discover({ paths: ["src/catalog/item.ts"], tags: ["API_%"] });
        expect(result.items.map((item) => item.label).sort()).toEqual(["Path", "Tagged"]);
        expect(result.items.find((item) => item.label === "Tagged")!.matches[0]!.reasons).toEqual([
          { kind: "tag", tag: "API_%" },
        ]);
      }),
    ),
  );

  it.effect(
    "keeps unscoped project browsing and general coverage distinct from text matching",
    () =>
      run(
        Effect.gen(function* () {
          const { projects, register, assignment, discover } = yield* fixture;
          yield* register("General", [assignment(0)]);
          yield* register("Other domain", [assignment(0, { paths: ["src/other"] })]);
          yield* register("Other project", [assignment(1)]);
          const project = projects[0]!.sharedProjectId;
          const browsing = yield* discover({ sharedProjectId: project });
          expect(browsing.items.map((item) => item.label).sort()).toEqual([
            "General",
            "Other domain",
          ]);
          expect(
            browsing.items.every((item) => item.matches[0]!.reasons[0]!.kind === "project"),
          ).toBe(true);
          const scoped = yield* discover({ sharedProjectId: project, paths: ["src/catalog"] });
          expect(scoped.items.map((item) => item.label)).toEqual(["General"]);
          expect(scoped.items[0]!.matches[0]!.reasons).toEqual([
            { kind: "project" },
            { kind: "general" },
          ]);
          expect(
            (yield* discover({
              sharedProjectId: project,
              paths: ["src/catalog"],
              query: "unrelated",
            })).items,
          ).toEqual([]);
        }),
      ),
  );

  it.effect(
    "searches labels and charters literally without treating percent or underscore as SQL patterns",
    () =>
      run(
        Effect.gen(function* () {
          const { register, assignment, discover } = yield* fixture;
          yield* register("OAuth_%", [assignment(0)]);
          yield* register("Charter match", [
            assignment(0, { charter: "Own OAuth_% enrollment and account recovery." }),
          ]);
          yield* register("Unrelated", [assignment(0, { charter: "Own OAuth-other enrollment." })]);
          const result = yield* discover({ query: "oAUTH_%" });
          expect(result.items.map((item) => item.label).sort()).toEqual([
            "Charter match",
            "OAuth_%",
          ]);
          expect(
            result.items.find((item) => item.label === "OAuth_%")!.matches[0]!.reasons,
          ).toEqual([{ kind: "description", source: "label" }]);
          expect(
            result.items.find((item) => item.label === "Charter match")!.matches[0]!.reasons,
          ).toEqual([{ kind: "description", source: "charter" }]);
          expect(
            (yield* discover({ query: "enrollment", paths: ["src/auth"] })).items
              .map((item) => item.label)
              .sort(),
          ).toEqual(["Charter match", "Unrelated"]);
        }),
      ),
  );

  it.effect(
    "returns one specialist with all matching project assignments and clearly labelled charter excerpts",
    () =>
      run(
        Effect.gen(function* () {
          const { store, projects, register, assignment, discover } = yield* fixture;
          const charter = `Catalog contracts. ${"Retain useful context. ".repeat(60)}`.trim();
          const specialist = yield* register("API contracts", [
            assignment(0, { charter, paths: ["src/contracts"], tags: ["api"] }),
            assignment(1, { charter: "Checkout contract validation.", paths: ["src/contracts"] }),
            assignment(2, { charter: "Shipping event delivery.", tags: ["events"] }),
          ]);
          const result = yield* discover({ paths: ["src/contracts/item.ts"], tags: ["api"] });
          expect(isResult(result)).toBe(true);
          expect(result.items).toHaveLength(1);
          expect(result.items[0]!.sharedProjectIds).toHaveLength(3);
          expect(result.items[0]!.matches.map((match) => match.sharedProjectId)).toEqual(
            projects.slice(0, 2).map((project) => project.sharedProjectId),
          );
          expect(result.items[0]!.matches[0]!.charterExcerpt).toBe(charter.slice(0, 600));
          expect(result.items[0]!.matches[0]!.charterExcerptTruncated).toBe(true);
          expect(result.items[0]!.matches[1]!.charterExcerptTruncated).toBe(false);
          expect((yield* store.specialist(specialist.specialistId)).assignments[0]!.charter).toBe(
            charter,
          );
          expect(result.items[0]).not.toHaveProperty("nativeTarget");
          expect(result.items[0]).not.toHaveProperty("availability");
          expect(
            (yield* discover({ sharedProjectId: projects[1]!.sharedProjectId, query: "catalog" }))
              .items,
          ).toEqual([]);
        }),
      ),
  );

  it.effect(
    "excludes superseded specialists by default without claiming their native work stopped",
    () =>
      run(
        Effect.gen(function* () {
          const { register, assignment, discover } = yield* fixture;
          const sql = yield* SqlClient.SqlClient;
          const old = yield* register("Earlier assignment", [assignment(0)]);
          const current = yield* register("Current assignment", [assignment(0)]);
          const changed = {
            ...old,
            supersededAt: "2026-10-17T12:00:00.000Z",
            successorId: current.specialistId,
          };
          yield* sql`UPDATE shared_specialists SET definition_json=${encode(changed)} WHERE specialist_id=${old.specialistId}`;
          expect((yield* discover({})).items.map((item) => item.specialistId)).toEqual([
            current.specialistId,
          ]);
          const included = yield* discover({ includeSuperseded: true });
          expect(included.items).toHaveLength(2);
          expect(
            included.items.find((item) => item.specialistId === old.specialistId),
          ).toMatchObject({
            supersededAt: changed.supersededAt,
            successorId: current.specialistId,
          });
        }),
      ),
  );

  it.effect("pages matching specialists by stable IDs, even with nonmatches between them", () =>
    run(
      Effect.gen(function* () {
        const { register, assignment, discover } = yield* fixture;
        for (let index = 0; index < 9; index++) {
          yield* register(`Specialist ${index}`, [
            assignment(index % 3, { tags: [index % 2 ? "other" : "api"] }),
          ]);
        }
        const full = yield* discover({ tags: ["api"] });
        const ids: string[] = [];
        let after: string | undefined;
        do {
          const page = yield* discover({ tags: ["api"], limit: 2, ...(after ? { after } : {}) });
          expect(page.items.length).toBeGreaterThan(0);
          expect(page.items.length).toBeLessThanOrEqual(2);
          ids.push(...page.items.map((item) => item.specialistId));
          after = page.nextCursor ?? undefined;
        } while (after && ids.length < 10);
        expect(ids).toEqual(full.items.map((item) => item.specialistId));
        expect(ids).toEqual([...ids].sort());
        expect(new Set(ids).size).toBe(5);
        expect((yield* discover({ after: ids[ids.length - 1], tags: ["api"] })).items).toEqual([]);
      }),
    ),
  );

  it.effect("fits whole Unicode-rich summaries into 192 KiB pages without losing matches", () =>
    run(
      Effect.gen(function* () {
        const { register, assignment, discover } = yield* fixture;
        for (let index = 0; index < 70; index++) {
          yield* register(`Specialist ${index}`, [
            assignment(0, { charter: "界".repeat(700) }),
            assignment(1, { charter: "界".repeat(700) }),
          ]);
        }
        const ids: string[] = [];
        let after: string | undefined;
        let pages = 0;
        do {
          const page = yield* discover({ limit: 100, ...(after ? { after } : {}) });
          expect(isResult(page)).toBe(true);
          expect(Buffer.byteLength(encode(page))).toBeLessThanOrEqual(192 * 1024);
          expect(page.items.length).toBeGreaterThan(0);
          expect(page.items.every((item) => item.matches.length === 2)).toBe(true);
          ids.push(...page.items.map((item) => item.specialistId));
          after = page.nextCursor ?? undefined;
          pages++;
        } while (after && pages < 5);
        expect(pages).toBe(2);
        expect(ids).toHaveLength(70);
        expect(new Set(ids).size).toBe(70);
        expect(ids).toEqual([...ids].sort());
      }),
    ),
  );

  it.effect("rejects invalid limits and nonliteral repository paths", () =>
    run(
      Effect.gen(function* () {
        const { discover } = yield* fixture;
        for (const input of [
          { limit: 0 },
          { limit: 101 },
          { paths: ["../secret"] },
          { paths: ["/absolute"] },
          { paths: ["src/./file"] },
          { paths: ["src\\file"] },
          { paths: ["src/\nfile"] },
          { paths: [""] },
        ]) {
          expect((yield* discover(input).pipe(Effect.flip)).code).toBe("invalid_input");
        }
      }),
    ),
  );

  it.effect("fails closed when a corrupt directory exceeds the bounded specialist scan", () =>
    run(
      Effect.gen(function* () {
        const { register, assignment, discover } = yield* fixture;
        const sql = yield* SqlClient.SqlClient;
        const original = yield* register("Original", [assignment(0)]);
        // Bypass registration deliberately to exercise the service's independent
        // scan bound against a persisted directory that violates store limits.
        for (let index = 0; index < 100; index++) {
          const specialistId = `overflow-${index.toString().padStart(3, "0")}`;
          const value = { ...original, specialistId };
          yield* sql`INSERT INTO shared_specialists
          (specialist_id,request_id,fingerprint,native_project_id,native_instance_id,native_agent_id,definition_json)
          VALUES (${specialistId},${specialistId},${specialistId},'catalog','meerkat',${specialistId},${encode(value)})`;
        }
        expect((yield* discover({}).pipe(Effect.flip)).code).toBe("limit_exceeded");
      }),
    ),
  );
});
