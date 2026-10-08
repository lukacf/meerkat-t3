import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type GitRunStackedActionResult,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  createdPullRequestKey,
  linkCreatedPullRequest,
  retryCreatedPullRequestLinks,
} from "./linkCreatedPullRequest.ts";
import {
  CreatedPullRequestLinkStore,
  type CreatedPullRequestLinkIntent,
} from "./CreatedPullRequestLinkStore.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as GitHubSourceControlProvider from "../sourceControl/GitHubSourceControlProvider.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";

const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");
const commandId = Effect.succeed(CommandId.make("server:pr-created-link:test"));

const project: OrchestrationProjectShell = {
  id: PROJECT_ID,
  title: "Project",
  workspaceRoot: "/workspace/project",
  defaultModelSelection: null,
  scripts: [],
  repositoryIdentity: {
    canonicalKey: "github.acme.test/platform/api",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "git@github.acme.test:Platform/API.git",
    },
    provider: "github",
    displayName: "Platform/API",
    owner: "Platform",
    name: "API",
  },
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

const thread: OrchestrationThreadShell = {
  id: THREAD_ID,
  projectId: PROJECT_ID,
  title: "Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  pullRequests: [],
  latestTurn: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: "2026-08-20T00:00:00.000Z",
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
};

function prResult(pr: GitRunStackedActionResult["pr"]): Pick<GitRunStackedActionResult, "pr"> {
  return { pr };
}

function pendingStore(): CreatedPullRequestLinkStore["Service"] {
  const intents = new Map<string, CreatedPullRequestLinkIntent>();
  return {
    list: Effect.sync(() => [...intents.values()]),
    put: (intent) =>
      Effect.sync(() => {
        intents.set(intent.commandId, intent);
      }),
    remove: (intent) =>
      Effect.sync(() => {
        intents.delete(intent.commandId);
      }),
  };
}

const makeDependencies = (
  dispatch: OrchestrationEngineShape["dispatch"],
  threadShell: OrchestrationThreadShell | null = thread,
  store = pendingStore(),
) =>
  Layer.mergeAll(
    Layer.succeed(CreatedPullRequestLinkStore, store),
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: () => Effect.succeed(Option.fromNullishOr(threadShell)),
      getProjectShellById: () => Effect.succeedSome(project),
    }),
    Layer.mock(OrchestrationEngineService)({
      readEvents: () => Stream.empty,
      dispatch,
      streamDomainEvents: Stream.empty,
      latestSequence: Effect.succeed(0),
    }),
  );

const recordingDispatch = Effect.fn("recordingDispatch")(function* () {
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const dispatch: OrchestrationEngineShape["dispatch"] = (command) =>
    Ref.update(commands, (recorded) => [...recorded, command]).pipe(Effect.as({ sequence: 1 }));
  return { commands, dispatch };
});

describe("createdPullRequestKey", () => {
  it("keeps an arbitrary Enterprise host and returned repository without checkout metadata", () => {
    expect(
      createdPullRequestKey(
        prResult({
          status: "created",
          number: 72,
          url: "https://code.acme.test:8443/Other/Delivery/pull/72",
        }),
        undefined,
      ),
    ).toEqual({
      host: "code.acme.test",
      repository: "other/delivery",
      number: 72,
      url: "https://code.acme.test:8443/Other/Delivery/pull/72",
    });
    expect(
      createdPullRequestKey(
        prResult({
          status: "created",
          number: 73,
          url: "https://code.acme.test:8443/Other/Delivery/pull/72",
        }),
        project,
      ),
    ).toBeNull();
  });

  it("reads host and repository from the URL when it is recognisable", () => {
    expect(
      createdPullRequestKey(
        prResult({
          status: "created",
          number: 12,
          url: "https://github.com/Other/Fork/pull/12",
        }),
        project,
      ),
    ).toEqual({
      host: "github.com",
      repository: "other/fork",
      number: 12,
      url: "https://github.com/Other/Fork/pull/12",
    });
  });

  it("falls back to the project's host and repository for an unreadable URL", () => {
    expect(
      createdPullRequestKey(
        prResult({ status: "opened_existing", number: 3, url: "https://ghe.internal/x/3" }),
        project,
      ),
    ).toEqual({
      host: "github.acme.test",
      repository: "platform/api",
      number: 3,
      url: "https://ghe.internal/x/3",
    });
    expect(
      createdPullRequestKey(
        prResult({ status: "created", number: 3, url: "https://ghe.internal/x/3" }),
        undefined,
      ),
    ).toBeNull();
  });

  it("yields nothing when no pull request came out of the action", () => {
    expect(
      createdPullRequestKey(prResult({ status: "skipped_not_requested" }), project),
    ).toBeNull();
    expect(
      createdPullRequestKey(
        prResult({ status: "created", url: "https://github.com/a/b/pull/1" }),
        project,
      ),
    ).toBeNull();
    expect(createdPullRequestKey(prResult({ status: "created", number: 1 }), project)).toBeNull();
  });
});

describe("linkCreatedPullRequest", () => {
  it.effect("links the direct creation receipt under its exact returned repository", () =>
    Effect.gen(function* () {
      const url = "https://code.acme.test:8443/other/delivery/pull/72";
      const provider = yield* GitHubSourceControlProvider.make.pipe(
        Effect.provide(GitHubCli.layer),
        Effect.provideService(VcsProcess.VcsProcess, {
          run: (input) =>
            input.args[0] === "pr" && input.args[1] === "create"
              ? Effect.succeed({
                  exitCode: ChildProcessSpawner.ExitCode(0),
                  stdout: `${url}\n`,
                  stderr: "",
                  stdoutTruncated: false,
                  stderrTruncated: false,
                })
              : Effect.die("Receipt linking must not require a GitHub lookup"),
        }),
      );
      const identity = yield* provider.createChangeRequest({
        cwd: "/workspace/project",
        baseRefName: "main",
        headSelector: "fork:feature",
        title: "Delivery review",
        bodyFile: "/tmp/pr.md",
      });
      if (!identity) return yield* Effect.die("Expected a direct successful creation identity");
      const { commands, dispatch } = yield* recordingDispatch();
      yield* linkCreatedPullRequest({
        threadId: THREAD_ID,
        result: prResult({ status: "created", ...identity }),
        commandId,
      }).pipe(Effect.provide(makeDependencies(dispatch)));
      expect(yield* Ref.get(commands)).toEqual([
        {
          type: "thread.pull-request.link",
          commandId: "server:pr-created-link:test",
          threadId: THREAD_ID,
          host: "code.acme.test",
          repository: "other/delivery",
          number: 72,
          url,
          source: "created",
        },
      ]);
    }),
  );

  it.effect("links a created pull request to the thread with source created", () =>
    Effect.gen(function* () {
      const { commands, dispatch } = yield* recordingDispatch();
      yield* linkCreatedPullRequest({
        threadId: THREAD_ID,
        result: prResult({
          status: "created",
          number: 42,
          url: "https://github.com/t3tools/t3code/pull/42",
        }),
        commandId,
      }).pipe(Effect.provide(makeDependencies(dispatch)));

      expect(yield* Ref.get(commands)).toEqual([
        {
          type: "thread.pull-request.link",
          commandId: "server:pr-created-link:test",
          threadId: THREAD_ID,
          host: "github.com",
          repository: "t3tools/t3code",
          number: 42,
          url: "https://github.com/t3tools/t3code/pull/42",
          source: "created",
        },
      ]);
    }),
  );

  it.effect("dispatches nothing when the action produced no pull request", () =>
    Effect.gen(function* () {
      const { commands, dispatch } = yield* recordingDispatch();
      const dependencies = makeDependencies(dispatch);
      yield* linkCreatedPullRequest({
        threadId: THREAD_ID,
        result: prResult({ status: "skipped_not_requested" }),
        commandId,
      }).pipe(Effect.provide(dependencies));
      yield* linkCreatedPullRequest({
        threadId: THREAD_ID,
        result: prResult({ status: "created", url: "https://github.com/t3tools/t3code/pull/42" }),
        commandId,
      }).pipe(Effect.provide(dependencies));

      expect(yield* Ref.get(commands)).toEqual([]);
    }),
  );

  it.effect(
    "retains exact identity before dispatch and replays it after branch change and archive",
    () =>
      Effect.gen(function* () {
        const store = pendingStore();
        const result = prResult({
          status: "created",
          number: 7,
          url: "https://github.com/Other/Fork/pull/7",
        });
        const status = yield* linkCreatedPullRequest({
          threadId: THREAD_ID,
          result,
          commandId,
        }).pipe(
          Effect.provide(
            makeDependencies(
              () =>
                Effect.gen(function* () {
                  expect(yield* store.list.pipe(Effect.orDie)).toEqual([
                    {
                      commandId: "server:pr-created-link:test",
                      threadId: THREAD_ID,
                      host: "github.com",
                      repository: "other/fork",
                      number: 7,
                      url: result.pr.url,
                    },
                  ]);
                  return yield* Effect.die(new Error("engine unavailable"));
                }),
              thread,
              store,
            ),
          ),
        );
        expect(status).toBe("pending");
        const { commands, dispatch } = yield* recordingDispatch();
        yield* retryCreatedPullRequestLinks.pipe(
          Effect.provide(
            makeDependencies(
              dispatch,
              { ...thread, branch: null, archivedAt: "2026-10-07T00:00:00.000Z" },
              store,
            ),
          ),
        );
        expect(yield* Ref.get(commands)).toEqual([
          {
            type: "thread.pull-request.link",
            commandId: "server:pr-created-link:test",
            threadId: THREAD_ID,
            host: "github.com",
            repository: "other/fork",
            number: 7,
            url: result.pr.url,
            source: "created",
          },
        ]);
        expect(yield* store.list).toEqual([]);
      }),
  );

  it.effect("commits the exact recovery intent before honoring cancellation during its write", () =>
    Effect.gen(function* () {
      const base = pendingStore();
      const putEntered = yield* Deferred.make<void>();
      const allowCommit = yield* Deferred.make<void>();
      const cancellationFinished = yield* Deferred.make<void>();
      const store: CreatedPullRequestLinkStore["Service"] = {
        ...base,
        put: (intent) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(putEntered, undefined);
            yield* Deferred.await(allowCommit);
            yield* base.put(intent);
          }),
      };
      const { commands, dispatch } = yield* recordingDispatch();
      const dependencies = makeDependencies(dispatch, thread, store);
      const result = prResult({
        status: "created",
        number: 7,
        url: "https://github.com/Other/Fork/pull/7",
      });
      const fiber = yield* linkCreatedPullRequest({
        threadId: THREAD_ID,
        result,
        commandId,
      }).pipe(Effect.provide(dependencies), Effect.forkChild);

      yield* Effect.gen(function* () {
        yield* Deferred.await(putEntered);
        const cancellation = yield* Fiber.interrupt(fiber).pipe(
          Effect.andThen(Deferred.succeed(cancellationFinished, undefined)),
          Effect.forkChild({ startImmediately: true }),
        );
        expect(yield* Deferred.isDone(cancellationFinished)).toBe(false);
        expect(yield* base.list).toEqual([]);
        yield* Deferred.succeed(allowCommit, undefined);
        yield* Fiber.join(cancellation);
        const exit = yield* Fiber.await(fiber);
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
        const expectedIntent = {
          commandId: "server:pr-created-link:test",
          threadId: THREAD_ID,
          host: "github.com",
          repository: "other/fork",
          number: 7,
          url: result.pr.url,
        };
        expect(yield* base.list).toEqual([expectedIntent]);
        expect(yield* Ref.get(commands)).toEqual([]);

        // Recovery needs only the saved identity and the orchestration engine.
        yield* retryCreatedPullRequestLinks.pipe(Effect.provide(dependencies));
        expect(yield* Ref.get(commands)).toEqual([
          { type: "thread.pull-request.link", ...expectedIntent, source: "created" },
        ]);
        expect(yield* base.list).toEqual([]);
      }).pipe(Effect.ensuring(Deferred.succeed(allowCommit, undefined)));
    }),
  );

  it.effect("only acknowledges duplicate rejection after exact visible-link readback", () =>
    Effect.gen(function* () {
      const store = pendingStore();
      const rejecting: OrchestrationEngineShape["dispatch"] = (command) =>
        Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "already linked",
          }),
        );
      const result = prResult({
        status: "opened_existing",
        number: 7,
        url: "https://github.com/t3tools/t3code/pull/7",
      });
      const failed = yield* linkCreatedPullRequest({ threadId: THREAD_ID, result, commandId }).pipe(
        Effect.provide(makeDependencies(rejecting, thread, store)),
      );
      expect(failed).toBe("pending");
      expect(yield* store.list).toHaveLength(1);
      const savedThread = {
        ...thread,
        pullRequests: [
          {
            host: "github.com",
            repository: "t3tools/t3code",
            number: 7,
            url: result.pr.url!,
            source: "created" as const,
            linkedAt: "2026-10-07T00:00:00.000Z",
            snapshot: null,
            stack: null,
          },
        ],
      };
      const linked = yield* linkCreatedPullRequest({ threadId: THREAD_ID, result, commandId }).pipe(
        Effect.provide(makeDependencies(rejecting, savedThread, store)),
      );
      expect(linked).toBe("linked");
      expect(yield* store.list).toEqual([]);
    }),
  );

  it.effect(
    "reports not saved if persistence fails, preserving host success without dispatch",
    () =>
      Effect.gen(function* () {
        const result = prResult({
          status: "created",
          number: 7,
          url: "https://github.com/a/b/pull/7",
        });
        const store = { ...pendingStore(), put: () => Effect.die("disk unavailable") };
        let dispatched = false;
        const status = yield* linkCreatedPullRequest({
          threadId: THREAD_ID,
          result,
          commandId,
        }).pipe(
          Effect.provide(
            makeDependencies(
              () =>
                Effect.sync(() => {
                  dispatched = true;
                  return { sequence: 1 };
                }),
              thread,
              store,
            ),
          ),
        );
        expect(status).toBe("not_saved");
        expect(dispatched).toBe(false);
        expect(result.pr.status).toBe("created");
        expect(result.pr.url).toBe("https://github.com/a/b/pull/7");
      }),
  );

  it.effect("discards recovery only when the rejected target no longer exists", () =>
    Effect.gen(function* () {
      const store = pendingStore();
      const status = yield* linkCreatedPullRequest({
        threadId: THREAD_ID,
        result: prResult({ status: "created", number: 7, url: "https://github.com/a/b/pull/7" }),
        commandId,
      }).pipe(
        Effect.provide(
          makeDependencies(
            (command) =>
              Effect.fail(
                new OrchestrationCommandInvariantError({
                  commandType: command.type,
                  detail: "thread deleted",
                }),
              ),
            null,
            store,
          ),
        ),
      );
      expect(status).toBe("not_saved");
      expect(yield* store.list).toEqual([]);
    }),
  );

  it.effect("keeps the original command identity if receipt cleanup fails", () =>
    Effect.gen(function* () {
      const base = pendingStore();
      let cleanupBlocked = true;
      const store = {
        ...base,
        remove: (intent: CreatedPullRequestLinkIntent) =>
          cleanupBlocked ? Effect.die("cleanup unavailable") : base.remove(intent),
      };
      const { commands, dispatch } = yield* recordingDispatch();
      const deps = makeDependencies(dispatch, thread, store);
      const status = yield* linkCreatedPullRequest({
        threadId: THREAD_ID,
        result: prResult({ status: "created", number: 7, url: "https://github.com/a/b/pull/7" }),
        commandId,
      }).pipe(Effect.provide(deps));
      expect(status).toBe("linked");
      expect(yield* store.list).toHaveLength(1);
      cleanupBlocked = false;
      yield* retryCreatedPullRequestLinks.pipe(Effect.provide(deps));
      const recorded = yield* Ref.get(commands);
      expect(recorded).toHaveLength(2);
      expect(recorded[1]).toEqual(recorded[0]);
      expect(yield* store.list).toEqual([]);
    }),
  );
});
