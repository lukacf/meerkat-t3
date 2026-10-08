// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ThreadId, type MeerkatTeamAgent } from "@t3tools/contracts";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";
import {
  openRestoreReview,
  decodeRestoreMarker,
  ProfileRestoreReview,
  readRestoreReviewSnapshot,
  requireRestoreReviewReleased,
  RESTORE_REVIEW_CAPABILITY_FILE,
  RESTORE_REVIEW_FILE,
} from "./restoreReview.ts";

const version = "0.0.48";
const marker = {
  version: 1,
  restoreId: "448a1ba2-df8c-4bb8-9fbe-c5f92b86578f",
  restoredAt: "2026-10-04T09:00:00.000Z",
  backupCreatedAt: "2026-10-03T09:00:00.000Z",
  appVersion: version,
};
const encodeFixtureJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const encodedMarker = encodeFixtureJson(marker);
const savedAgent = (id: string, extra: Partial<MeerkatTeamAgent> = {}): MeerkatTeamAgent => ({
  agentRef: `${id}-ref`,
  durableId: id,
  mobId: "domain-mob",
  mobLabel: "Specialist",
  mobKind: "domain",
  scopeLabel: "Project agent",
  projectAgentId: "definition",
  record: {
    identity: id,
    display_name: id,
    runtime_key: "native",
    runtime_member_id: id,
    session_id: `${id}-session`,
    visibility: "addressable",
    addressable: true,
    health: "ready",
    labels: {},
  },
  ...extra,
});
const seedDestinationProject = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const date = marker.restoredAt;
  yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES ('project','Garden','/project','[]',${date},${date})`;
  yield* sql`INSERT INTO projection_threads (thread_id,project_id,title,model_selection_json,created_at,updated_at) VALUES ('thread','project','Review delivery','{}',${date},${date})`;
  yield* sql`INSERT INTO meerkat_project_agents (agent_id,project_id,instance_id,request_id,request_fingerprint,label,role,instructions,model,provider_state_root,state_root,mob_id,agent_identity,created_at,updated_at) VALUES ('definition','project','native','create','fingerprint','Reviewer','review','Review','openai:gpt','/provider','/state','domain-mob','primary',${date},${date})`;
});
const saveObservedDestination = Effect.fn("test.saveObservedDestination")(function* (
  agent: MeerkatTeamAgent,
  observedAt = marker.restoredAt,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO meerkat_observed_agents (agent_ref,durable_id,project_id,instance_id,provider_state_root,project_path,state_root,thread_id,agent_json,last_seen_at)
    VALUES (${agent.agentRef},${agent.durableId ?? agent.agentRef},'project','native','/provider','/project','/state',${agent.threadId ?? null},${encodeFixtureJson(agent)},${observedAt})`;
});
const saveQueuedDestination = Effect.fn("test.saveQueuedDestination")(function* (
  id: string,
  agent: MeerkatTeamAgent,
  overrides: Record<string, unknown> = {},
) {
  const sql = yield* SqlClient.SqlClient;
  const date = marker.restoredAt;
  const binding = {
    projectId: "project",
    instanceId: "native",
    durableId: agent.durableId ?? agent.agentRef,
    providerStateRoot: "/provider",
    projectPath: "/project",
    stateRoot: "/state",
    mobId: agent.mobId,
    identity: agent.record.identity,
    ...overrides,
  };
  yield* sql`INSERT INTO meerkat_agent_queues (target_key,project_id,instance_id,durable_id,binding_json)
    VALUES (${id},'project','native',${agent.durableId ?? agent.agentRef},${encodeFixtureJson(binding)})`;
  yield* sql`INSERT INTO meerkat_agent_queue_items (item_id,target_key,request_id,enqueue_fingerprint,payload_json,position,status,created_at,updated_at)
    VALUES (${id},${id},${id},'fingerprint','{"text":"Please review this change"}',0,'queued',${date},${date})`;
});
async function withProfile(work: (root: string) => Promise<void>) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-restore-review-"));
  try {
    await work(root);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
}

describe("restored profile admission", () => {
  it("leaves a normal profile open and records its installed guard capability", () =>
    withProfile(async (root) => {
      const review = await openRestoreReview(root, version);
      expect(review.held).toBe(false);
      expect(review.status().status).toBe("clear");
      expect(
        JSON.parse(
          await NodeFSP.readFile(NodePath.join(root, RESTORE_REVIEW_CAPABILITY_FILE), "utf8"),
        ),
      ).toEqual({ version: 1, appVersion: version });
      expect(await NodeFSP.readdir(root)).toEqual([RESTORE_REVIEW_CAPABILITY_FILE]);
    }));

  it.effect("requires matching durable consent and a new process before releasing work", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-restore-review-")),
      );
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
      );
      const file = NodePath.join(root, RESTORE_REVIEW_FILE);
      yield* Effect.promise(() => NodeFSP.writeFile(file, encodedMarker));
      const review = yield* Effect.promise(() => openRestoreReview(root, version));
      expect(review.held).toBe(true);
      expect(review.status().status).toBe("required");
      yield* Effect.promise(() =>
        expect(review.consent("another-restore")).rejects.toThrow("does not match"),
      );
      expect(
        decodeRestoreMarker(yield* Effect.promise(() => NodeFSP.readFile(file, "utf8")), version),
      ).toEqual(marker);
      const consented = yield* Effect.promise(() => review.consent(marker.restoreId));
      expect(consented.status).toBe("restart-required");
      expect(review.held).toBe(true);
      expect(review.status().status).toBe("restart-required");
      expect(
        yield* requireRestoreReviewReleased.pipe(
          Effect.provideService(ProfileRestoreReview, review),
          Effect.flip,
        ),
      ).toMatchObject({ _tag: "RestoreReviewError" });
      const stored = decodeRestoreMarker(
        yield* Effect.promise(() => NodeFSP.readFile(file, "utf8")),
        version,
      );
      expect(stored).toMatchObject(marker);
      expect(typeof stored.consentedAt).toBe("string");
      expect((yield* Effect.promise(() => review.consent(marker.restoreId))).status).toBe(
        "restart-required",
      );
      expect(
        decodeRestoreMarker(yield* Effect.promise(() => NodeFSP.readFile(file, "utf8")), version)
          .consentedAt,
      ).toBe(stored.consentedAt);
      const restarted = yield* Effect.promise(() => openRestoreReview(root, version));
      expect(restarted.held).toBe(false);
      expect(restarted.status().status).toBe("clear");
      expect((yield* Effect.promise(() => openRestoreReview(root, "0.0.49"))).held).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.each([
    ["broken JSON", "{"],
    ["unknown format", JSON.stringify({ ...marker, version: 2 })],
    ["missing identity", JSON.stringify({ ...marker, restoreId: "" })],
    ["invalid date", JSON.stringify({ ...marker, restoredAt: "yesterday" })],
    ["wrong pending app version", JSON.stringify({ ...marker, appVersion: "0.0.42" })],
    ["invalid consent", JSON.stringify({ ...marker, consentedAt: true })],
    ["oversized marker", JSON.stringify({ ...marker, extra: "x".repeat(4096) })],
  ])("holds %s metadata without altering its evidence", (_name, content) =>
    withProfile(async (root) => {
      const file = NodePath.join(root, RESTORE_REVIEW_FILE);
      await NodeFSP.writeFile(file, content!);
      const review = await openRestoreReview(root, version);
      expect(review.held).toBe(true);
      expect(review.status().status).toBe("invalid");
      await expect(review.consent(marker.restoreId)).rejects.toThrow();
      expect(await NodeFSP.readFile(file, "utf8")).toBe(content);
    }),
  );

  it("holds a symlinked marker and will not write consent through it", () =>
    withProfile(async (root) => {
      const source = NodePath.join(root, "original.json");
      await NodeFSP.writeFile(source, JSON.stringify(marker));
      await NodeFSP.symlink(source, NodePath.join(root, RESTORE_REVIEW_FILE));
      const review = await openRestoreReview(root, version);
      expect(review.status().status).toBe("invalid");
      await expect(review.consent(marker.restoreId)).rejects.toThrow();
      expect(JSON.parse(await NodeFSP.readFile(source, "utf8"))).toEqual(marker);
    }));

  it("rejects consent after the restore identity changes and returns detached status values", () =>
    withProfile(async (root) => {
      const file = NodePath.join(root, RESTORE_REVIEW_FILE);
      await NodeFSP.writeFile(file, JSON.stringify(marker));
      const review = await openRestoreReview(root, version);
      const oldStatus = review.status();
      Object.assign(oldStatus, { status: "clear" });
      expect(review.status().status).toBe("required");
      const changed = { ...marker, restoreId: "c6cb80b2-5db5-4dcb-a355-015b9ed08148" };
      await NodeFSP.writeFile(file, JSON.stringify(changed));
      await expect(review.consent(marker.restoreId)).rejects.toThrow("changed");
      expect(review.held).toBe(true);
      expect(JSON.parse(await NodeFSP.readFile(file, "utf8"))).toEqual(changed);
    }));

  it.effect("reads bounded consumer records without writes or inferring an unloaded mailbox", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const date = marker.restoredAt;
      yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES ('project','Project','/project','[]',${date},${date})`;
      yield* sql`INSERT INTO projection_threads (thread_id,project_id,title,model_selection_json,created_at,updated_at) VALUES ('thread','project','Interrupted work','{}',${date},${date})`;
      yield* sql`INSERT INTO provider_session_runtime (thread_id,provider_name,provider_instance_id,adapter_key,status,last_seen_at,runtime_payload_json) VALUES ('thread','meerkat','native','native','ready',${date},' {"continueAfterServerUpdate":"turn"}')`;
      yield* sql`INSERT INTO meerkat_agent_queues (target_key,project_id,instance_id,durable_id,binding_json) VALUES ('queue','project','native','agent','{}')`;
      for (let index = 0; index < 102; index += 1) {
        const id = `item-${index}`;
        yield* sql`INSERT INTO meerkat_agent_queue_items (item_id,target_key,request_id,enqueue_fingerprint,payload_json,position,status,created_at,updated_at) VALUES (${id},'queue',${id},'fingerprint','{"text":"Saved queued work"}',${index},'queued',${date},${date})`;
      }
      for (const [id, receipt] of [
        ["uncertain", '{"status":"uncertain"}'],
        ["invalid", "{"],
        ["accepted", '{"status":"accepted"}'],
      ]) {
        yield* sql`INSERT INTO meerkat_agent_delivery_receipts (project_id,instance_id,request_id,fingerprint,receipt_json,created_at) VALUES ('project','native',${id},'fingerprint',${receipt},${date})`;
      }
      yield* sql`INSERT INTO meerkat_project_agents (agent_id,project_id,instance_id,request_id,request_fingerprint,label,role,instructions,model,provider_state_root,state_root,mob_id,agent_identity,created_at,updated_at) VALUES ('definition','project','native','create','fingerprint','Specialist','review','Review','openai:gpt','/provider','/state','mob','primary',${date},${date})`;
      for (const [ref, durableId, agentJson] of [
        [
          "primary-ref",
          "primary",
          '{"projectAgentId":"definition","record":{"display_name":"Specialist"}}',
        ],
        [
          "helper-ref",
          "helper",
          '{"projectAgentId":"definition","record":{"display_name":"Helper"}}',
        ],
        [
          "helper-old-ref",
          "helper",
          '{"projectAgentId":"definition","record":{"display_name":"Old helper"}}',
        ],
      ]) {
        const seen = ref === "helper-old-ref" ? marker.backupCreatedAt : date;
        yield* sql`INSERT INTO meerkat_observed_agents (agent_ref,durable_id,project_id,instance_id,provider_state_root,project_path,agent_json,last_seen_at) VALUES (${ref},${durableId},'project','native','/provider','/project',${agentJson},${seen})`;
      }
      const before = yield* sql<{ count: number }>`SELECT total_changes() AS count`;
      const snapshot = yield* readRestoreReviewSnapshot;
      const after = yield* sql<{ count: number }>`SELECT total_changes() AS count`;
      expect(after).toEqual(before);
      expect(snapshot.counts).toEqual({
        queuedMessages: 102,
        uncertainDeliveries: 2,
        interruptedSessions: 1,
        savedAgents: 3,
      });
      expect(snapshot.nativeMailbox).toBe("unknown-unloaded");
      expect(snapshot.truncated).toBe(true);
      expect(snapshot.items.filter((item) => item.kind === "queued-message")).toHaveLength(100);
      expect(snapshot.items.some((item) => item.label === "Helper")).toBe(true);
      expect(snapshot.items.some((item) => item.label === "Old helper")).toBe(false);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect(
    "identifies queued specialists and worker conversations from saved identity without releasing the hold",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedDestinationProject;
        const primary = savedAgent("primary");
        const child = savedAgent("child", {
          record: {
            ...savedAgent("child").record,
            display_name: "Security reviewer",
            labels: { source_mob_id: "child-crew" },
          },
        });
        const worker = savedAgent("worker", {
          mobId: "thread-mob",
          projectAgentId: undefined,
          threadId: ThreadId.make("thread"),
          record: {
            ...savedAgent("worker").record,
            display_name: "Tests",
            labels: { spawned_by: "coordinator" },
          },
        });
        for (const agent of [primary, child, worker]) {
          yield* saveObservedDestination(agent);
          yield* saveQueuedDestination(`${agent.record.identity}-message`, agent);
        }
        yield* saveObservedDestination(
          { ...worker, agentRef: "old-worker-ref" },
          marker.backupCreatedAt,
        );
        const before = yield* sql<{ count: number }>`SELECT total_changes() AS count`;
        const snapshot = yield* readRestoreReviewSnapshot;
        const reopened = yield* readRestoreReviewSnapshot;
        expect(reopened).toEqual(snapshot);
        expect(snapshot.status).toBe("required");
        expect(snapshot.items.filter((item) => item.kind === "queued-message")).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: "primary-message",
              label: "Message to Garden / Reviewer",
              destination: {
                kind: "project-agent",
                label: "Garden / Reviewer",
                agentId: "definition",
                instanceId: "native",
              },
            }),
            expect.objectContaining({
              id: "child-message",
              destination: {
                kind: "project-agent",
                label: "Garden / Reviewer / Security reviewer",
                agentId: "definition",
                instanceId: "native",
                nativeAgent: "child-ref",
              },
            }),
            expect.objectContaining({
              id: "worker-message",
              threadId: "thread",
              destination: {
                kind: "thread",
                label: "Garden / Review delivery / Tests",
                threadId: "thread",
                member: "worker-ref",
              },
            }),
          ]),
        );
        expect(yield* sql<{ count: number }>`SELECT total_changes() AS count`).toEqual(before);
        expect((yield* Effect.exit(requireRestoreReviewReleased))._tag).toBe("Failure");
      }).pipe(
        Effect.provideService(ProfileRestoreReview, {
          held: true,
          status: () => ({
            status: "required",
            restoreId: marker.restoreId,
            restoredAt: marker.restoredAt,
            backupCreatedAt: marker.backupCreatedAt,
            message: "Paused",
          }),
          consent: () => Promise.reject(new Error("Inventory must not consent")),
        }),
        Effect.provide(SqlitePersistenceMemory),
      ),
  );

  it.effect("keeps legacy, mismatched and deleted destinations visible without guessed links", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedDestinationProject;
      const primary = savedAgent("primary");
      yield* saveObservedDestination(primary);
      for (const field of [
        "projectId",
        "instanceId",
        "durableId",
        "providerStateRoot",
        "projectPath",
        "stateRoot",
        "mobId",
        "identity",
      ]) {
        yield* saveQueuedDestination(field, primary, { [field]: "different" });
      }
      yield* saveQueuedDestination("legacy", primary);
      yield* sql`UPDATE meerkat_agent_queues SET binding_json='{}' WHERE target_key='legacy'`;
      const ambiguous = savedAgent("ambiguous", { threadId: ThreadId.make("thread") });
      yield* saveObservedDestination(ambiguous);
      yield* saveQueuedDestination("ambiguous", ambiguous);
      const deleted = savedAgent("deleted", {
        projectAgentId: undefined,
        threadId: ThreadId.make("thread"),
        mobId: "thread-mob",
      });
      yield* saveObservedDestination(deleted);
      yield* saveQueuedDestination("deleted", deleted);
      yield* sql`UPDATE projection_threads SET deleted_at=${marker.restoredAt} WHERE thread_id='thread'`;
      yield* sql`INSERT INTO provider_session_runtime (thread_id,provider_name,provider_instance_id,adapter_key,status,last_seen_at,runtime_payload_json) VALUES ('thread','meerkat','native','native','running',${marker.restoredAt},'{}')`;
      const snapshot = yield* readRestoreReviewSnapshot;
      const queued = snapshot.items.filter((item) => item.kind === "queued-message");
      expect(queued).toHaveLength(11);
      expect(
        queued.every((item) => item.destination === undefined && item.label === "Saved message"),
      ).toBe(true);
      expect(
        snapshot.items.find((item) => item.kind === "interrupted-session")?.destination,
      ).toBeUndefined();
      expect(
        snapshot.items.find((item) => item.kind === "saved-agent" && item.id === "definition")
          ?.destination,
      ).toEqual({
        kind: "project-agent",
        label: "Garden / Reviewer",
        agentId: "definition",
        instanceId: "native",
      });
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
});
