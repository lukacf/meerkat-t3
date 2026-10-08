// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - opt-in packaged server acceptance with private processes and a controlled loopback provider.
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  CommandId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WS_METHODS,
  type MeerkatTeamAgent,
  type OrchestrationThreadStreamItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "@effect/vitest";
import {
  initializeUpgradeRepository,
  inspectPackage,
} from "./MeerkatProfileUpgrade.server.native.support.ts";
import {
  availablePort,
  bounded,
  configureWorkspace,
  exchangeToken,
  ownedServer,
  prepareFixture,
  watch,
  withClient,
  workflowKey,
  workflowModel,
} from "./MeerkatWorkflow.server.native.support.ts";

const packageApp = process.env.T3CODE_TEST_MEERKAT_NOHOST_APP;
const instanceId = ProviderInstanceId.make("meerkat");
const projectId = ProjectId.make("preview-nohost-project");
const threadId = ThreadId.make("preview-nohost-thread");
const selection = { instanceId, model: workflowModel };
const phases = ["READY", "REFUSAL", "CONTINUE"] as const;
type Phase = (typeof phases)[number];
const encodeEvidence = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeRequest = Schema.decodeUnknownSync(
  Schema.Struct({
    model: Schema.String,
    input: Schema.Array(Schema.Unknown),
    tools: Schema.Array(Schema.Unknown),
  }),
);
const decodeUser = Schema.decodeUnknownOption(
  Schema.Struct({
    role: Schema.Literal("user"),
    content: Schema.Union([
      Schema.String,
      Schema.Array(Schema.Struct({ type: Schema.Literal("input_text"), text: Schema.String })),
    ]),
  }),
);
const decodeTool = Schema.decodeUnknownOption(
  Schema.Struct({ type: Schema.Literal("function"), name: Schema.String }),
);
const decodeToolTag = Schema.decodeUnknownSync(Schema.Struct({ type: Schema.String }));
const decodeOutput = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.Literal("function_call_output"),
    call_id: Schema.String,
    output: Schema.Union([
      Schema.String,
      Schema.Array(Schema.Struct({ type: Schema.Literal("input_text"), text: Schema.String })),
    ]),
  }),
);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

function controlledProvider() {
  const failed = Promise.withResolvers<never>();
  void failed.promise.catch(() => undefined);
  const steps = new Map<Phase, number>();
  const calls: { phase: Phase; step: number; previewTools: string[] }[] = [];
  let workspace = "";
  let forbiddenNavigations = 0;
  let shellVerified = false;
  const provider = NodeHttp.createServer(async (request, response) => {
    try {
      if (request.url === "/forbidden-open") {
        forbiddenNavigations += 1;
        throw new Error("An ungranted browser mutation reached the navigation witness");
      }
      expect(request.method).toBe("POST");
      expect(request.url).toBe("/v1/responses");
      expect(request.headers.authorization).toBe(`Bearer ${workflowKey}`);
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const payload = decodeRequest(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      expect(payload.model).toBe("gpt-5.6-sol");
      const latest = payload.input
        .flatMap((value) => {
          const user = decodeUser(value);
          return Option.isSome(user)
            ? [
                typeof user.value.content === "string"
                  ? user.value.content
                  : user.value.content.map((part) => part.text).join("\n"),
              ]
            : [];
        })
        .at(-1);
      const matches = phases.filter((phase) => latest?.includes(`NOHOST_${phase}`));
      expect(matches).toHaveLength(1);
      const phase = matches[0]!;
      const step = steps.get(phase) ?? 0;
      const tools = payload.tools.flatMap((value) => {
        if (decodeToolTag(value).type !== "function") return [];
        const tool = decodeTool(value);
        expect(Option.isSome(tool), "Every offered function must expose its native name").toBe(
          true,
        );
        return [Option.getOrThrow(tool).name];
      });
      const previewTools = tools.filter((tool) => tool.startsWith("preview_"));
      expect(previewTools, "No desktop host must offer no native browser tools").toEqual([]);
      calls.push({ phase, step, previewTools });
      const callId = `nohost_${phase}`;
      const outputs = payload.input.flatMap((value) => {
        const output = decodeOutput(value);
        return Option.isSome(output) && output.value.call_id === callId
          ? [
              typeof output.value.output === "string"
                ? output.value.output
                : output.value.output.map((part) => part.text).join("\n"),
            ]
          : [];
      });
      let item: object;
      if (phase !== "READY" && step === 0) {
        const address = provider.address();
        if (!address || typeof address === "string") throw new Error("Fixture port unavailable");
        if (phase === "CONTINUE") {
          expect(tools).toContain("shell");
          expect(encodeEvidence(payload.input)).toContain("NOHOST_READY_COMPLETE");
        }
        const script = `const fs=require('node:fs');process.stdout.write('NOHOST_SHELL:'+fs.realpathSync('.')+':'+fs.readFileSync('scope.txt','utf8').trim());`;
        item = {
          type: "function_call",
          id: `fc_${callId}`,
          call_id: callId,
          status: "completed",
          name: phase === "REFUSAL" ? "preview_open" : "shell",
          arguments: JSON.stringify(
            phase === "REFUSAL"
              ? { url: `http://127.0.0.1:${address.port}/forbidden-open` }
              : { command: `${quote(process.execPath)} -e ${quote(script)}`, timeout_secs: 10 },
          ),
        };
      } else {
        // The native visibility precheck terminalizes unadvertised tools before
        // dispatch. A refused call must never trigger another provider request.
        expect(phase).not.toBe("REFUSAL");
        expect(step).toBe(phase === "READY" ? 0 : 1);
        if (phase !== "READY") expect(outputs).toHaveLength(1);
        if (phase === "CONTINUE") {
          expect(workspace).not.toBe("");
          expect(outputs[0]).toContain(`NOHOST_SHELL:${workspace}:NOHOST_WORKTREE`);
          shellVerified = true;
        }
        item = {
          type: "message",
          id: `msg_${callId}`,
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: `NOHOST_${phase}_COMPLETE` }],
        };
      }
      steps.set(phase, step + 1);
      const id = `response_nohost_${calls.length}`;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        [
          { type: "response.created", response: { id } },
          { type: "response.output_item.added", output_index: 0, item },
          ...("call_id" in item
            ? [{ ...item, type: "response.function_call_arguments.done", item_id: `fc_${callId}` }]
            : []),
          {
            type: "response.completed",
            response: {
              id,
              status: "completed",
              output: [item],
              usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
            },
          },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(""),
      );
    } catch {
      failed.reject(new Error("Controlled no-host provider assertion failed"));
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "No-host fixture failed" } }));
    }
  });
  return {
    provider,
    failed: failed.promise,
    setWorkspace: (path: string) => {
      workspace = path;
    },
    evidence: () => ({ calls, forbiddenNavigations, shellVerified }),
  };
}

function threadSession(item: OrchestrationThreadStreamItem) {
  return item.kind === "snapshot"
    ? item.snapshot.thread.session
    : item.kind === "event" && item.event.type === "thread.session-set"
      ? item.event.payload.session
      : undefined;
}
const expectedRefusal = "Tool not found: preview_open";
function threadFailure(item: OrchestrationThreadStreamItem, allowRefusal: boolean) {
  const session = threadSession(item);
  if (allowRefusal && session?.status === "error" && session.lastError?.includes(expectedRefusal))
    return undefined;
  if (
    session?.status === "error" ||
    (item.kind === "event" &&
      item.event.type === "thread.activity-appended" &&
      item.event.payload.activity.kind === "provider.turn.start.failed")
  )
    return new Error("The isolated no-host native thread failed");
  return undefined;
}
function coordinator(agents: readonly MeerkatTeamAgent[]) {
  const matches = agents.filter(
    (agent) =>
      agent.threadId === threadId &&
      agent.mobKind === "thread" &&
      agent.record.runtime_member_id === "ingress" &&
      !agent.record.labels.source_mob_id,
  );
  expect(matches).toHaveLength(1);
  expect(matches[0]!.record.session_id).toBeTruthy();
  return matches[0]!;
}

describe.skipIf(!packageApp)("Meerkat packaged server without a desktop preview host", () => {
  it.live(
    "refuses browser access and unadvertised mutations while preserving native development work",
    () =>
      Effect.gen(function* () {
        if (!packageApp) throw new Error("Supply an extracted packaged app");
        const pkg = yield* Effect.promise(() => inspectPackage(packageApp));
        const root = yield* Effect.promise(async () =>
          NodeFSP.realpath(
            await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-preview-nohost-")),
          ),
        );
        yield* Effect.promise(() => NodeFSP.chmod(root, 0o700));
        const fixture = controlledProvider();
        let server: ReturnType<typeof ownedServer> | undefined;
        const grants: unknown[] = [];
        let sessionId: string | undefined;
        let mutationRefused = false;
        yield* Effect.addFinalizer((exit) =>
          Effect.promise(async () => {
            let cleanupComplete = false;
            try {
              await server?.close();
              cleanupComplete = true;
            } finally {
              fixture.provider.closeAllConnections();
              if (fixture.provider.listening)
                await new Promise<void>((resolve, reject) =>
                  fixture.provider.close((error) => (error ? reject(error) : resolve())),
                );
              await NodeFSP.mkdir(NodePath.join(root, "evidence"), {
                recursive: true,
                mode: 0o700,
              });
              await NodeFSP.writeFile(
                NodePath.join(root, "evidence", "nohost-acceptance.json"),
                encodeEvidence({
                  passed: Exit.isSuccess(exit) && cleanupComplete,
                  cleanupComplete,
                  desktopHostStarted: false,
                  app: pkg.app,
                  archiveSha256: pkg.archiveSha256,
                  executableSha256: pkg.executableSha256,
                  manifest: pkg.manifest,
                  sessionId,
                  mutationRefused,
                  grants,
                  ...fixture.evidence(),
                }),
                { mode: 0o600 },
              );
            }
          }).pipe(Effect.ensuring(Effect.logInfo(`Packaged no-host evidence retained at ${root}`))),
        );
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve, reject) => {
              fixture.provider.once("error", reject);
              fixture.provider.listen(0, "127.0.0.1", resolve);
            }),
        );
        const address = fixture.provider.address();
        if (!address || typeof address === "string") throw new Error("Fixture port unavailable");
        const prepared = yield* Effect.promise(() =>
          prepareFixture(root, pkg.runtime, address.port),
        );
        yield* Effect.promise(() =>
          initializeUpgradeRepository(prepared.projectPath, prepared.env),
        );
        const port = yield* Effect.promise(availablePort);
        expect(port).not.toBe(52258);
        const origin = `http://127.0.0.1:${port}`;
        server = ownedServer(
          pkg.entry,
          prepared.projectPath,
          prepared.baseDir,
          port,
          prepared.env,
          NodePath.join(prepared.evidenceRoot, "server-diagnostics.json"),
          pkg.executable,
        );
        const bearer = yield* exchangeToken(
          origin,
          yield* Effect.promise(() =>
            bounded(server!.ready, "packaged no-host server readiness", 60_000),
          ),
        );
        yield* withClient(origin, bearer, (client) =>
          Effect.gen(function* () {
            const config = yield* client[WS_METHODS.serverGetConfig]({});
            expect(
              config.providers
                .filter((provider) => provider.enabled)
                .map((provider) => provider.instanceId),
            ).toEqual([instanceId]);
            const provider = config.providers.find(
              (candidate) => candidate.instanceId === instanceId,
            );
            expect(provider?.status).toBe("ready");
            expect(provider?.version).toBe(
              `${pkg.manifest.build.meerkatVersion} / MobKit ${pkg.manifest.build.mobkitVersion}`,
            );
            yield* client[WS_METHODS.serverUpdateSettings]({
              patch: { enableAgentBrowserAccess: true },
            });
            yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
              type: "project.create",
              commandId: CommandId.make("nohost-project"),
              projectId,
              title: "No desktop host acceptance",
              workspaceRoot: prepared.projectPath,
              createdAt: DateTime.formatIso(DateTime.nowUnsafe()),
            });
            const created = yield* client[WS_METHODS.vcsCreateWorktree]({
              cwd: prepared.projectPath,
              refName: "main",
              newRefName: "codex/nohost-worktree",
              path: NodePath.join(root, "worktree"),
            });
            const workspace = yield* Effect.promise(() => NodeFSP.realpath(created.worktree.path));
            expect(workspace).not.toBe(prepared.projectPath);
            fixture.setWorkspace(workspace);
            yield* Effect.promise(() =>
              configureWorkspace(
                workspace,
                prepared.nativeRoot,
                pkg.runtime,
                address.port,
                prepared.env,
              ),
            );
            yield* client[WS_METHODS.projectsWriteFile]({
              cwd: workspace,
              relativePath: "scope.txt",
              contents: "NOHOST_WORKTREE\n",
            });
            yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
              type: "thread.create",
              commandId: CommandId.make("nohost-thread"),
              threadId,
              projectId,
              title: "Usable native agent without Browser",
              modelSelection: selection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: created.worktree.refName,
              worktreePath: workspace,
              createdAt: DateTime.formatIso(DateTime.nowUnsafe()),
            });
            const shell = yield* watch(
              client[ORCHESTRATION_WS_METHODS.subscribeShell]({ requestCompletionMarker: true }),
            );
            let allowRefusal = false;
            const thread = yield* watch(
              client[ORCHESTRATION_WS_METHODS.subscribeThread]({ threadId }),
              (item) => threadFailure(item, allowRefusal),
            );
            yield* shell.waitFor(
              (item) => item.kind === "synchronized",
              "no-host shell subscription",
            );
            yield* thread.waitFor(
              (item) => item.kind === "snapshot",
              "no-host thread subscription",
            );
            const run = Effect.fnUntraced(function* (phase: Phase) {
              const afterShell = shell.index(),
                afterThread = thread.index();
              allowRefusal = phase === "REFUSAL";
              yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
                type: "thread.turn.start",
                commandId: CommandId.make(`nohost-${phase}`),
                threadId,
                message: {
                  messageId: MessageId.make(`nohost-${phase}`),
                  role: "user",
                  text: `NOHOST_${phase}`,
                  attachments: [],
                },
                modelSelection: selection,
                runtimeMode: "full-access",
                interactionMode: "default",
                createdAt: DateTime.formatIso(DateTime.nowUnsafe()),
              });
              if (phase === "REFUSAL") {
                yield* thread.waitFor(
                  (item) => {
                    const session = threadSession(item);
                    return (
                      session?.status === "error" &&
                      session.lastError?.includes(expectedRefusal) === true
                    );
                  },
                  "no-host native mutation refusal",
                  afterThread,
                );
                yield* shell.waitFor(
                  (item) =>
                    item.kind === "thread-upserted" &&
                    item.thread.id === threadId &&
                    item.thread.latestTurn?.state === "error" &&
                    item.thread.session?.status === "error" &&
                    item.thread.session.lastError?.includes(expectedRefusal) === true,
                  "no-host refused turn terminal receipt",
                  afterShell,
                );
                mutationRefused = true;
                return;
              }
              yield* thread.waitFor(
                (item) =>
                  item.kind === "snapshot"
                    ? item.snapshot.thread.messages.some(
                        (message) =>
                          message.role === "assistant" &&
                          message.text === `NOHOST_${phase}_COMPLETE` &&
                          !message.streaming,
                      )
                    : item.kind === "event" &&
                      item.event.type === "thread.message-sent" &&
                      item.event.payload.role === "assistant" &&
                      item.event.payload.text === `NOHOST_${phase}_COMPLETE` &&
                      !item.event.payload.streaming,
                `no-host ${phase} committed reply`,
                afterThread,
              );
              yield* shell.waitFor(
                (item) =>
                  item.kind === "thread-upserted" &&
                  item.thread.id === threadId &&
                  item.thread.latestTurn?.state === "completed" &&
                  item.thread.session?.status === "ready",
                `no-host ${phase} terminal receipt`,
                afterShell,
              );
            });
            yield* run("READY");
            const before = coordinator(
              (yield* client[WS_METHODS.meerkatProjectTeam]({ projectId })).providers.flatMap(
                (provider) => provider.agents,
              ),
            );
            sessionId = before.record.session_id;
            const target = { projectId, instanceId, threadId };
            for (const grant of [
              yield* client[WS_METHODS.meerkatBrowserStatus](target),
              yield* client[WS_METHODS.meerkatBrowserGrant]({ ...target, enabled: true }),
              yield* client[WS_METHODS.meerkatBrowserStatus](target),
            ]) {
              expect(grant.enabled).toBe(false);
              expect(grant.reason).toBe("no-host");
              expect(grant.sessionId).toBe(sessionId);
              expect(grant.tools ?? []).toEqual([]);
              grants.push(grant);
            }
            yield* run("REFUSAL");
            yield* run("CONTINUE");
            const after = coordinator(
              (yield* client[WS_METHODS.meerkatProjectTeam]({ projectId })).providers.flatMap(
                (provider) => provider.agents,
              ),
            );
            expect(after.record.session_id).toBe(sessionId);
            expect(after.agentRef).toBe(before.agentRef);
            expect((yield* client[WS_METHODS.previewList]({ threadId })).sessions).toEqual([]);
            const snapshot = yield* client[ORCHESTRATION_WS_METHODS.subscribeThread]({
              threadId,
            }).pipe(
              Stream.filter((item) => item.kind === "snapshot"),
              Stream.runHead,
              Effect.map(Option.getOrThrow),
            );
            for (const phase of ["READY", "CONTINUE"])
              expect(
                snapshot.snapshot.thread.messages.filter(
                  (message) =>
                    message.role === "assistant" && message.text === `NOHOST_${phase}_COMPLETE`,
                ),
              ).toHaveLength(1);
            expect(fixture.evidence()).toMatchObject({
              forbiddenNavigations: 0,
              shellVerified: true,
            });
            expect(mutationRefused).toBe(true);
            expect(fixture.evidence().calls.map(({ phase, step }) => ({ phase, step }))).toEqual([
              { phase: "READY", step: 0 },
              { phase: "REFUSAL", step: 0 },
              { phase: "CONTINUE", step: 0 },
              { phase: "CONTINUE", step: 1 },
            ]);
          }),
        ).pipe(Effect.raceFirst(Effect.promise(() => fixture.failed)));
      }).pipe(Effect.scoped, Effect.timeout("240 seconds")),
    250_000,
  );
});
