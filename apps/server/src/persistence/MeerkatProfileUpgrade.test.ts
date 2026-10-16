// @effect-diagnostics nodeBuiltinImport:off - real configure CLI and isolated files prove upgrade preservation.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeUtil from "node:util";
import * as NodeURL from "node:url";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  MEERKAT_RUNTIME_FILES,
  meerkatFileHash,
  meerkatTarget,
} from "@t3tools/shared/meerkatRuntime";
import { runMigrations } from "./Migrations.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const repo = NodeURL.fileURLToPath(new URL("../../../../", import.meta.url));
const io = <A>(run: () => Promise<A>) => Effect.promise(run);
const hash = (bytes: Uint8Array | string) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const now = "2026-09-26T08:00:00.000Z";
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeSettings = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const selectedTables = [
  "orchestration_events",
  "projection_projects",
  "projection_threads",
  "projection_thread_messages",
  "projection_thread_sessions",
  "provider_session_runtime",
  "meerkat_project_agents",
  "meerkat_thread_connections",
  "meerkat_peer_connections",
  "meerkat_observed_agents",
  "meerkat_agent_delivery_receipts",
] as const;

async function files(root: string, prefix = ""): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};
  for (const entry of await NodeFSP.readdir(NodePath.join(root, prefix), { withFileTypes: true })) {
    const relative = NodePath.join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(entries, await files(root, relative));
    else entries[relative] = hash(await NodeFSP.readFile(NodePath.join(root, relative)));
  }
  return entries;
}

const harness = Effect.fnUntraced(function* () {
  const keep = process.env.MEERKAT_UPGRADE_ARTIFACT_ROOT;
  const root = yield* Effect.acquireRelease(
    io(async () => {
      if (keep) await NodeFSP.mkdir(keep, { recursive: true });
      return NodeFSP.mkdtemp(NodePath.join(keep ?? NodeOS.tmpdir(), "upgrade-"));
    }),
    (root) => (keep ? Effect.void : io(() => NodeFSP.rm(root, { recursive: true, force: true }))),
  );
  const home = NodePath.join(root, "profile with spaces");
  const native = NodePath.join(home, "native original");
  const project = NodePath.join(root, "project [original]");
  const runtime = NodePath.join(root, "fixture-runtime");
  yield* io(async () => {
    for (const directory of [NodePath.join(home, "userdata/attachments"), native, project, runtime])
      await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
    const bundleFiles: Record<string, string> = {};
    for (const name of [meerkatTarget().binary, ...MEERKAT_RUNTIME_FILES]) {
      const data = Buffer.from(`synthetic verification fixture: ${name}`);
      await NodeFSP.writeFile(NodePath.join(runtime, name), data, { mode: 0o700 });
      bundleFiles[name] = meerkatFileHash(data);
    }
    await NodeFSP.writeFile(
      NodePath.join(runtime, "manifest.json"),
      JSON.stringify({
        format: 1,
        binary: meerkatTarget().binary,
        build: {
          ...meerkatTarget(),
          gatewayVersion: "0.1.0",
          meerkatVersion: "0.8.42",
          mobkitVersion: "0.8.42",
          cargoLockSha256: "a".repeat(64),
        },
        files: bundleFiles,
      }),
    );
  });
  const secret = "synthetic-token-must-not-be-logged";
  const oldSettings = {
    theme: "dark",
    enableAgentBrowserAccess: false,
    enableAgentDeviceAccess: false,
    defaultRuntimeMode: "approvals",
    defaultModelSelection: { instanceId: "meerkat", model: "openai:gpt-fixture" },
    providerInstances: {
      meerkat: {
        driver: "meerkat",
        displayName: "Existing runtime",
        enabled: true,
        config: {
          gatewayBinaryPath: "/old/source/build/gateway",
          stateRoot: native,
          projectPath: project,
          workspacePolicy: "existing-policy",
          inheritedSecret: secret,
        },
      },
      custom: {
        driver: "codex",
        displayName: "Keep custom",
        enabled: true,
        config: { cliBinaryPath: "/custom/path" },
      },
    },
  };
  yield* io(() =>
    NodeFSP.writeFile(NodePath.join(home, "userdata/settings.json"), JSON.stringify(oldSettings), {
      mode: 0o600,
    }),
  );
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS2cAAAAASUVORK5CYII=",
    "base64",
  );
  const blobHash = hash(`image/png\0${png.toString("base64")}`);
  const attachment = {
    type: "image",
    id: "thread-original-00000000-0000-4000-8000-000000000001",
    name: "original.png",
    mimeType: "image/png",
    sizeBytes: png.length,
  };
  const content = [
    { type: "image", media_type: "image/png", source: "blob", blob_id: `sha256:${blobHash}` },
  ];
  const nativeMob = NodePath.join(native, "mobkit", "original-mob");
  yield* io(async () => {
    await NodeFSP.mkdir(NodePath.join(nativeMob, "blobs/objects"), { recursive: true });
    await NodeFSP.mkdir(NodePath.join(nativeMob, "blobs/meta"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(nativeMob, `blobs/objects/${blobHash}.bin`), png);
    await NodeFSP.writeFile(
      NodePath.join(nativeMob, `blobs/meta/${blobHash}.json`),
      JSON.stringify({
        media_type: "image/png",
        size: png.length,
        created_at_ms: 1,
        source: "fixture",
      }),
    );
    await NodeFSP.writeFile(
      NodePath.join(home, "userdata/attachments", `${attachment.id}.png`),
      png,
    );
    const console = new NodeSqlite.DatabaseSync(NodePath.join(nativeMob, "console.sqlite"));
    try {
      console.exec(
        "CREATE TABLE console_frames(cursor_seq INTEGER PRIMARY KEY,id TEXT,dedupe_key TEXT,timestamp_ms INTEGER,runtime_key TEXT,identity TEXT,conversation_id TEXT,session_id TEXT,kind TEXT,status TEXT,frame_version INTEGER,updated_at_ms INTEGER,payload_json TEXT,source_kind TEXT,source_cursor TEXT,source_event_id TEXT,interaction_id TEXT,parent_frame_id TEXT,caused_by_frame_id TEXT,turn_id TEXT,run_id TEXT)",
      );
      console
        .prepare(
          "INSERT INTO console_frames(cursor_seq,id,dedupe_key,timestamp_ms,runtime_key,identity,session_id,kind,status,frame_version,payload_json,source_kind) VALUES (1,'frame-original','frame-original',1,'default','reviewer','session-original','user_message','completed',1,?,'fixture')",
        )
        .run(JSON.stringify({ content }));
    } finally {
      console.close();
    }
    await NodeFSP.writeFile(
      NodePath.join(nativeMob, "topology-control.json"),
      JSON.stringify({ fixture: true, edges: [{ from: "reviewer", to: "coordinator" }] }),
    );
    await NodeFSP.writeFile(
      NodePath.join(native, "runs.jsonl"),
      `${JSON.stringify({ runId: "run-original", sessionId: "session-original", status: "completed" })}\n`,
    );
    await NodeFSP.writeFile(
      NodePath.join(native, "config.toml"),
      "[model_fallback]\nenabled = false\n",
    );
  });
  const filename = NodePath.join(home, "userdata/state.sqlite");
  const database = NodeSqliteClient.layer({ filename });
  yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 59 });
    yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES ('project-original','Original project',${project},'[]',${now},${now})`;
    const model = encodeJson(oldSettings.defaultModelSelection);
    yield* sql`INSERT INTO projection_threads (thread_id,project_id,title,model_selection_json,runtime_mode,created_at,updated_at) VALUES ('thread-original','project-original','Original work',${model},'full-access',${now},${now})`;
    yield* sql`INSERT INTO projection_thread_messages (message_id,thread_id,role,text,is_streaming,created_at,updated_at,attachments_json) VALUES ('message-original','thread-original','user','Inspect the original image',0,${now},${now},${encodeJson([attachment])})`;
    yield* sql`INSERT INTO projection_thread_sessions (thread_id,status,provider_name,provider_session_id,provider_thread_id,updated_at,provider_instance_id) VALUES ('thread-original','idle','meerkat','session-original','original-mob',${now},'meerkat')`;
    const cursor = encodeJson({
      version: 1,
      threadId: "thread-original",
      mobId: "original-mob",
      projectPath: project,
      stateRoot: native,
      lastRunId: "run-original",
    });
    yield* sql`INSERT INTO provider_session_runtime (thread_id,provider_name,adapter_key,status,last_seen_at,resume_cursor_json,provider_instance_id) VALUES ('thread-original','meerkat','meerkat','idle',${now},${cursor},'meerkat')`;
    const payload = encodeJson({
      threadId: "thread-original",
      messageId: "message-original",
      attachments: [attachment],
    });
    yield* sql`INSERT INTO orchestration_events (event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json) VALUES ('event-original','thread','thread-original',1,'thread.message-sent',${now},'user',${payload},'{}')`;
    yield* sql`INSERT INTO meerkat_project_agents (agent_id,project_id,instance_id,request_id,request_fingerprint,label,role,instructions,model,provider_state_root,state_root,mob_id,agent_identity,created_at,updated_at) VALUES ('agent-original','project-original','meerkat','request-create','fingerprint','Reviewer','reviewer','Review carefully','openai:gpt-fixture',${native},${native},'original-mob','reviewer',${now},${now})`;
    yield* sql`INSERT INTO meerkat_thread_connections (thread_id,project_id,instance_id,agent_ids_json,request_id,updated_at) VALUES ('thread-original','project-original','meerkat','["agent-original"]','connect-original',${now})`;
    yield* sql`INSERT INTO meerkat_peer_connections (edge_id,source_key,target_key,source_json,target_json,provider_state_root,desired,request_id,updated_at) VALUES ('edge-original','agent-original','thread-original','{"agentId":"agent-original"}','{"threadId":"thread-original"}',${native},1,'peer-original',${now})`;
    yield* sql`INSERT INTO meerkat_observed_agents (agent_ref,durable_id,project_id,instance_id,provider_state_root,project_path,state_root,thread_id,agent_json,last_seen_at) VALUES ('agent-original','durable-original','project-original','meerkat',${native},${project},${native},'thread-original','{"record":{"identity":"reviewer","session_id":"session-original"}}',${now})`;
    yield* sql`INSERT INTO meerkat_agent_delivery_receipts (project_id,instance_id,request_id,fingerprint,receipt_json,created_at,stable_fingerprint) VALUES ('project-original','meerkat','send-original','exact-fingerprint','{"status":"uncertain"}',${now},'stable-fingerprint')`;
  }).pipe(Effect.provide(database));
  const configure = (args: ReadonlyArray<string> = []) =>
    execFile(
      process.execPath,
      [
        NodePath.join(repo, "scripts/meerkat-prototype.mjs"),
        "configure",
        "--home-dir",
        home,
        ...args,
      ],
      {
        cwd: root,
        env: { PATH: process.env.PATH, HOME: root, MEERKAT_RUNTIME_DIR: runtime },
        timeout: 30_000,
      },
    );
  const readRows = () => {
    const db = new NodeSqlite.DatabaseSync(filename, { readOnly: true });
    try {
      return Object.fromEntries(
        selectedTables.map((name) => [name, db.prepare(`SELECT * FROM ${name}`).all()]),
      );
    } finally {
      db.close();
    }
  };
  return {
    root,
    home,
    native,
    nativeMob,
    project,
    secret,
    oldSettings,
    png,
    blobHash,
    attachment,
    database,
    configure,
    readRows,
  };
});

it.effect(
  "upgrades a populated profile in place through the real configure CLI and migrations without losing durable references",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const before = yield* io(async () => ({ files: await files(h.home), rows: h.readRows() }));
      const baseline = NodePath.join(h.root, "immutable-before-profile");
      yield* io(() => NodeFSP.cp(h.home, baseline, { recursive: true }));
      const baselineHashes = yield* io(() => files(baseline));
      const output = yield* io(() => h.configure());
      expect(output.stdout).toContain(h.home);
      expect(output.stdout + output.stderr).not.toContain(h.secret);
      const settings = decodeSettings(
        yield* io(() => NodeFSP.readFile(NodePath.join(h.home, "userdata/settings.json"), "utf8")),
      );
      expect(settings.providerInstances).toMatchObject({
        meerkat: {
          ...h.oldSettings.providerInstances.meerkat,
          config: {
            ...h.oldSettings.providerInstances.meerkat.config,
            gatewayBinaryPath: "meerkat-desktop-stdio",
          },
        },
        custom: h.oldSettings.providerInstances.custom,
      });
      expect(settings.enableAgentBrowserAccess).toBe(false);
      expect(settings.defaultRuntimeMode).toBe("approvals");
      expect(settings.defaultModelSelection).toEqual(h.oldSettings.defaultModelSelection);
      expect(
        (yield* io(() => NodeFSP.stat(NodePath.join(h.home, "userdata/settings.json")))).mode &
          0o777,
      ).toBe(0o600);
      const configured = yield* io(() => files(h.home));
      for (const [name, digest] of Object.entries(before.files))
        if (name !== "userdata/settings.json") expect(configured[name], name).toBe(digest);
      const migrated = yield* runMigrations().pipe(Effect.provide(h.database));
      expect(migrated.map(([id]) => id)).toEqual([60, 61, 62, 63, 64, 65, 66, 67, 68, 69]);
      const afterRows = h.readRows();
      for (const name of selectedTables) {
        expect(afterRows[name]?.length).toBe(before.rows[name]?.length);
        for (const [index, row] of before.rows[name]!.entries())
          expect(afterRows[name]?.[index], name).toMatchObject(row);
      }
      expect(afterRows.meerkat_project_agents?.[0]).toMatchObject({
        revision_version: 1,
        pending_revision_json: null,
      });
      expect(afterRows.meerkat_agent_delivery_receipts?.[0]).toMatchObject({
        native_target_json: null,
      });
      const afterConfigure = yield* io(() =>
        NodeFSP.readFile(NodePath.join(h.home, "userdata/settings.json"), "utf8"),
      );
      yield* io(() => h.configure());
      expect(
        yield* io(() => NodeFSP.readFile(NodePath.join(h.home, "userdata/settings.json"), "utf8")),
      ).toBe(afterConfigure);
      expect(yield* runMigrations().pipe(Effect.provide(h.database))).toEqual([]);
      expect(h.readRows()).toEqual(afterRows);
      expect(yield* io(() => files(baseline))).toEqual(baselineHashes);
      const finalFiles = yield* io(() => files(h.home));
      for (const [name, digest] of Object.entries(before.files))
        if (!name.startsWith("userdata/state.sqlite") && name !== "userdata/settings.json")
          expect(finalFiles[name], name).toBe(digest);
      expect(
        yield* io(() =>
          NodeFSP.readFile(NodePath.join(h.nativeMob, `blobs/objects/${h.blobHash}.bin`)),
        ),
      ).toEqual(h.png);
      yield* io(() =>
        NodeFSP.writeFile(
          NodePath.join(h.root, "acceptance.json"),
          JSON.stringify(
            {
              source: "synthetic",
              route: "in-place",
              migrated: migrated.map(([id]) => id),
              tables: selectedTables.length,
              beforeFiles: before.files,
              finalFiles,
              baselineUnchanged: true,
              repeatIdempotent: true,
              secretLogged: false,
              nativeResumeTested: false,
            },
            null,
            2,
          ),
        ),
      );
    }).pipe(Effect.scoped),
);

it.effect(
  "rejects unsupported import and ambiguous profile options before mutating the selected profile",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const before = yield* io(() => files(h.home));
      for (const args of [
        ["--import", h.root],
        ["--legacy-profile"],
        ["--home-dir", h.root],
        ["--home-dir"],
      ]) {
        const result = yield* io(() =>
          h.configure(args).then(
            () => "succeeded",
            (error: Error) => error.message,
          ),
        );
        expect(result).not.toBe("succeeded");
        expect(yield* io(() => files(h.home))).toEqual(before);
      }
    }).pipe(Effect.scoped),
);
