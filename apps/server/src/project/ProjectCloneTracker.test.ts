import { describe, expect, it } from "@effect/vitest";
import {
  OrchestrationDispatchCommandError,
  ProjectId,
  SourceControlRepositoryError,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import {
  ProjectCloneIntentStore,
  makeProjectCloneIntent,
  type ProjectCloneIntent,
} from "./ProjectCloneIntentStore.ts";
import * as ProjectCloneTracker from "./ProjectCloneTracker.ts";
import { parseGitCloneProgressLine } from "./gitCloneProgress.ts";

const projectId = ProjectId.make("project-1");
const startInput = {
  projectId,
  title: "t3code",
  createdAt: "2026-01-01T00:00:00.000Z",
  remoteUrl: "git@github.com:octocat/t3code.git",
  destinationPath: "/workspace/t3code",
};

function makeIntentStore(initial: ReadonlyArray<ProjectCloneIntent> = []) {
  const saved = new Map(initial.map((intent) => [intent.projectId, intent]));
  const store = ProjectCloneIntentStore.of({
    list: Effect.sync(() => [...saved.values()]),
    put: (intent) => Effect.sync(() => void saved.set(intent.projectId, intent)),
    remove: (id) => Effect.sync(() => void saved.delete(id)),
  });
  return { saved, store };
}

const initialIntent = makeProjectCloneIntent(
  startInput,
  {
    destinationPath: startInput.destinationPath,
    remoteUrl: startInput.remoteUrl,
    cloneUrl: startInput.remoteUrl,
    repository: null,
  },
  startInput.createdAt,
);

function makeHarness(options?: {
  readonly clone?: SourceControlRepositoryService.SourceControlRepositoryService["Service"]["cloneRepository"];
  readonly prepare?: SourceControlRepositoryService.SourceControlRepositoryService["Service"]["prepareClone"];
  readonly intents?: ReturnType<typeof makeIntentStore>;
}) {
  const intents = options?.intents ?? makeIntentStore();
  const created: Array<{ projectId: ProjectId; workspaceRoot: string }> = [];
  const cloned: Array<ProjectId> = [];
  const discarded: Array<string> = [];
  const hooks: ProjectCloneTracker.ProjectCloneHooks = {
    createProject: (input) =>
      Effect.sync(() => {
        created.push({ projectId: input.projectId, workspaceRoot: input.workspaceRoot });
      }),
    onCloned: (input) => Effect.sync(() => void cloned.push(input.projectId)),
  };
  const layer = ProjectCloneTracker.layer.pipe(
    Layer.provide(Layer.succeed(ProjectCloneIntentStore, intents.store)),
    Layer.provide(
      Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({
        prepareClone:
          options?.prepare ??
          ((input) =>
            Effect.succeed({
              destinationPath: input.destinationPath,
              remoteUrl: input.remoteUrl ?? "",
              cloneUrl: input.remoteUrl ?? "",
              repository: null,
            })),
        cloneRepository:
          options?.clone ??
          ((input) =>
            Effect.succeed({
              cwd: input.destinationPath,
              remoteUrl: input.remoteUrl ?? "",
              repository: null,
            })),
        discardClone: (destination) => Effect.sync(() => void discarded.push(destination)),
      }),
    ),
  );
  return { layer, hooks, created, cloned, discarded, intents };
}

describe("ProjectCloneTracker", () => {
  it.effect("creates the project first and reports the clone through the stream", () => {
    const release = Deferred.makeUnsafe<void>();
    const harness = makeHarness({
      clone: (input, options) =>
        Effect.gen(function* () {
          yield* (
            options?.onProgress?.({ stage: "receiving", percent: 40, detail: "1 MiB" }) ??
              Effect.void
          );
          yield* Deferred.await(release);
          return { cwd: input.destinationPath, remoteUrl: input.remoteUrl ?? "", repository: null };
        }),
    });
    return Effect.gen(function* () {
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      const collected = yield* tracker.stream.pipe(
        Stream.takeUntil((clones) => clones[0]?.phase === "done"),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;

      const result = yield* tracker.start(startInput, harness.hooks);
      expect(result.cwd).toBe("/workspace/t3code");
      // The project exists before git runs so the draft can open immediately.
      expect(harness.created).toEqual([{ projectId, workspaceRoot: "/workspace/t3code" }]);

      yield* Effect.yieldNow;
      const running = yield* tracker.get(projectId);
      expect(running).toMatchObject({ phase: "running", stage: "receiving", percent: 40 });

      yield* Deferred.succeed(release, undefined);
      const lists = yield* Fiber.join(collected);
      const final = lists.at(-1)?.[0];
      expect(final).toMatchObject({ phase: "done", percent: 100 });
      expect(harness.cloned).toEqual([projectId]);

      // Done clones drop out after the grace window so the toast can settle.
      yield* TestClock.adjust("31 seconds");
      expect(yield* tracker.get(projectId)).toBeNull();
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("keeps a failed clone with git's own explanation and retries it", () => {
    let attempts = 0;
    const harness = makeHarness({
      clone: (input) =>
        Effect.suspend(() => {
          attempts += 1;
          return attempts === 1
            ? Effect.fail(
                new SourceControlRepositoryError({
                  operation: "cloneRepository",
                  provider: "unknown",
                  detail: "fatal: repository not found",
                }),
              )
            : Effect.succeed({
                cwd: input.destinationPath,
                remoteUrl: input.remoteUrl ?? "",
                repository: null,
              });
        }),
    });
    return Effect.gen(function* () {
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      yield* tracker.start(startInput, harness.hooks);
      yield* Effect.yieldNow;
      const failed = yield* tracker.get(projectId);
      expect(failed).toMatchObject({ phase: "failed", error: "fatal: repository not found" });

      expect(yield* tracker.retry(projectId)).toBe(true);
      // The partial checkout is cleared so git sees an empty destination.
      expect(harness.discarded).toEqual(["/workspace/t3code"]);
      yield* Effect.yieldNow;
      expect((yield* tracker.get(projectId))?.phase).toBe("done");
      expect(attempts).toBe(2);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("cancel interrupts the clone and removes the partial checkout", () => {
    const harness = makeHarness({ clone: () => Effect.never });
    return Effect.gen(function* () {
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      yield* tracker.start(startInput, harness.hooks);
      yield* Effect.yieldNow;

      expect(yield* tracker.cancel(projectId)).toBe(true);
      expect((yield* tracker.get(projectId))?.phase).toBe("cancelled");
      expect(harness.discarded).toEqual(["/workspace/t3code"]);
      // Nothing left to cancel; retry is what brings it back.
      expect(yield* tracker.cancel(projectId)).toBe(false);
      expect(yield* tracker.retry(projectId)).toBe(true);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("a cancel that lands after git finished keeps the checkout", () => {
    const gate = Deferred.makeUnsafe<void>();
    const harness = makeHarness();
    // The clone itself completes instantly; the post-clone hook is what hangs.
    const hooks: ProjectCloneTracker.ProjectCloneHooks = {
      ...harness.hooks,
      onCloned: () => Deferred.await(gate),
    };
    return Effect.gen(function* () {
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      yield* tracker.start(startInput, hooks);
      yield* Effect.yieldNow;
      expect((yield* tracker.get(projectId))?.phase).toBe("done");
      expect(yield* tracker.cancel(projectId)).toBe(false);
      expect(harness.discarded).toEqual([]);
      yield* Deferred.succeed(gate, undefined);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("hands git the credential-bearing URL while snapshots carry the redacted one", () => {
    const cloneUrls: Array<string> = [];
    const harness = makeHarness({
      clone: (input) =>
        Effect.sync(() => {
          cloneUrls.push(input.remoteUrl ?? "");
          return { cwd: input.destinationPath, remoteUrl: "", repository: null };
        }),
    });
    const layer = ProjectCloneTracker.layer.pipe(
      Layer.provide(Layer.succeed(ProjectCloneIntentStore, harness.intents.store)),
      Layer.provide(
        Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({
          prepareClone: (input) =>
            Effect.succeed({
              destinationPath: input.destinationPath,
              remoteUrl: "https://github.com/octocat/t3code.git",
              cloneUrl: "https://user:s3cret@github.com/octocat/t3code.git",
              repository: null,
            }),
          cloneRepository: (input) =>
            Effect.sync(() => {
              cloneUrls.push(input.remoteUrl ?? "");
              return { cwd: input.destinationPath, remoteUrl: "", repository: null };
            }),
          discardClone: () => Effect.void,
        }),
      ),
    );
    return Effect.gen(function* () {
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      const result = yield* tracker.start(startInput, harness.hooks);
      yield* Effect.yieldNow;
      expect(result.remoteUrl).toBe("https://github.com/octocat/t3code.git");
      expect(cloneUrls).toEqual(["https://user:s3cret@github.com/octocat/t3code.git"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("discard forgets a project's clone when the project is deleted", () => {
    const harness = makeHarness({ clone: () => Effect.never });
    return Effect.gen(function* () {
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      yield* tracker.start(startInput, harness.hooks);
      yield* Effect.yieldNow;
      yield* tracker.discard(projectId);
      expect(yield* tracker.get(projectId)).toBeNull();
      expect(harness.discarded).toEqual(["/workspace/t3code"]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("releases the claim when project creation fails", () => {
    const harness = makeHarness();
    const hooks: ProjectCloneTracker.ProjectCloneHooks = {
      ...harness.hooks,
      createProject: () =>
        Effect.fail(new OrchestrationDispatchCommandError({ message: "workspace root exists" })),
    };
    return Effect.gen(function* () {
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      const error = yield* Effect.flip(tracker.start(startInput, hooks));
      expect(error.message).toContain("workspace root exists");
      expect(yield* tracker.get(projectId)).toBeNull();
      // The destination is free again for a corrected attempt.
      yield* tracker.start(startInput, harness.hooks);
      yield* Effect.yieldNow;
      expect((yield* tracker.get(projectId))?.phase).toBe("done");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("does not create a project when the clone cannot be prepared", () => {
    const harness = makeHarness();
    const layer = ProjectCloneTracker.layer.pipe(
      Layer.provide(Layer.succeed(ProjectCloneIntentStore, harness.intents.store)),
      Layer.provide(
        Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({
          prepareClone: () =>
            Effect.fail(
              new SourceControlRepositoryError({
                operation: "cloneRepository",
                provider: "unknown",
                detail: "Destination path already exists and is not empty.",
              }),
            ),
        }),
      ),
    );
    return Effect.gen(function* () {
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      const error = yield* Effect.flip(tracker.start(startInput, harness.hooks));
      expect(error.message).toContain("not empty");
      expect(harness.created).toEqual([]);
      expect(yield* tracker.get(projectId)).toBeNull();
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "restores failed clone admission and clears durable intent only after a successful retry",
    () => {
      const intents = makeIntentStore();
      const first = makeHarness({
        intents,
        clone: () =>
          Effect.fail(
            new SourceControlRepositoryError({
              operation: "cloneRepository",
              provider: "unknown",
              detail: "The local remote does not exist.",
            }),
          ),
      });
      const restored = makeHarness({ intents });
      return Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
          yield* tracker.start(startInput, first.hooks);
          yield* tracker.stream.pipe(
            Stream.filter((entries) => entries[0]?.phase === "failed"),
            Stream.take(1),
            Stream.runDrain,
          );
          expect(intents.saved.get(projectId)?.phase).toBe("failed");
        }).pipe(Effect.provide(first.layer));

        yield* Effect.gen(function* () {
          const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
          expect((yield* tracker.get(projectId))?.phase).toBe("failed");
          const snapshots = yield* tracker.stream.pipe(Stream.take(1), Stream.runCollect);
          expect(snapshots[0]?.[0]?.projectId).toBe(projectId);
          const rejected = yield* ProjectCloneTracker.rejectCommandsDuringClone(
            tracker,
            {
              type: "thread.create",
              projectId,
            },
            () => Effect.succeed(null),
          ).pipe(Effect.flip);
          expect(rejected.message).toContain("Retry the clone first");
          yield* ProjectCloneTracker.rejectCommandsDuringClone(
            tracker,
            {
              type: "thread.turn.start",
              bootstrap: { createThread: { projectId } },
            },
            () => Effect.succeed(null),
          ).pipe(Effect.flip);
          expect(yield* tracker.retry(projectId, restored.hooks.onCloned)).toBe(true);
          yield* tracker.stream.pipe(
            Stream.filter((entries) => entries[0]?.phase === "done"),
            Stream.take(1),
            Stream.runDrain,
          );
          expect(intents.saved.size).toBe(0);
          expect(restored.created).toEqual([]);
          expect(restored.discarded).toEqual([]);
          expect(restored.cloned).toEqual([projectId]);
          yield* ProjectCloneTracker.rejectCommandsDuringClone(
            tracker,
            {
              type: "thread.create",
              projectId,
            },
            () => Effect.succeed(null),
          );
        }).pipe(Effect.provide(restored.layer));
      });
    },
  );

  it.effect("hydrates an interrupted clone before serving its first snapshot", () => {
    const harness = makeHarness({ intents: makeIntentStore([initialIntent]) });
    return Effect.gen(function* () {
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      const snapshots = yield* tracker.stream.pipe(Stream.take(1), Stream.runCollect);
      expect(snapshots[0]?.[0]).toMatchObject({ projectId, phase: "failed" });
      expect(snapshots[0]?.[0]?.error).toContain("before the server stopped");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "preserves cancelled state and never deletes a restored checkout on project removal",
    () => {
      const intents = makeIntentStore([{ ...initialIntent, phase: "cancelled" }]);
      const harness = makeHarness({ intents });
      return Effect.gen(function* () {
        const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
        expect((yield* tracker.get(projectId))?.phase).toBe("cancelled");
        yield* tracker.discard(projectId);
        expect(yield* tracker.get(projectId)).toBeNull();
        expect(intents.saved.size).toBe(0);
        expect(harness.discarded).toEqual([]);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("refuses to clear files from a partial checkout restored after restart", () => {
    const intents = makeIntentStore([initialIntent]);
    let cloneCalls = 0;
    const harness = makeHarness({
      intents,
      prepare: () =>
        Effect.fail(
          new SourceControlRepositoryError({
            operation: "cloneRepository",
            provider: "unknown",
            detail: "Destination path already exists and is not empty.",
          }),
        ),
      clone: () =>
        Effect.sync(() => {
          cloneCalls += 1;
          return {
            cwd: startInput.destinationPath,
            remoteUrl: startInput.remoteUrl,
            repository: null,
          };
        }),
    });
    return Effect.gen(function* () {
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      const error = yield* tracker.retry(projectId).pipe(Effect.flip);
      expect(error.detail).toContain("Existing files were kept");
      expect(cloneCalls).toBe(0);
      expect(harness.discarded).toEqual([]);
      expect(intents.saved.size).toBe(1);
      expect((yield* tracker.get(projectId))?.phase).toBe("failed");
      yield* tracker.discard(projectId);
      expect(harness.discarded).toEqual([]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "requires re-entry of an unsaved credential-bearing URL without touching the checkout",
    () => {
      const harness = makeHarness({
        intents: makeIntentStore([{ ...initialIntent, retryInput: null }]),
      });
      return Effect.gen(function* () {
        const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
        const error = yield* tracker.retry(projectId).pipe(Effect.flip);
        expect(error.detail).toContain("original clone URL was not saved");
        expect(harness.discarded).toEqual([]);
        expect(harness.cloned).toEqual([]);
        expect(harness.intents.saved.size).toBe(1);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("does not create a project when durable intent cannot be saved", () => {
    const intents = makeIntentStore();
    const harness = makeHarness({
      intents: {
        ...intents,
        store: {
          ...intents.store,
          put: () =>
            Effect.fail(
              new SourceControlRepositoryError({
                operation: "saveCloneRecovery",
                provider: "unknown",
                detail: "Disk is full.",
              }),
            ),
        },
      },
    });
    return Effect.gen(function* () {
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      const error = yield* tracker.start(startInput, harness.hooks).pipe(Effect.flip);
      expect(error.message).toContain("Disk is full");
      expect(harness.created).toEqual([]);
      expect(yield* tracker.get(projectId)).toBeNull();
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("releases a failed start claim even when durable cleanup also fails", () => {
    const intents = makeIntentStore();
    const storageError = new SourceControlRepositoryError({
      operation: "saveCloneRecovery",
      provider: "unknown",
      detail: "Storage unavailable.",
    });
    const harness = makeHarness({
      intents: {
        ...intents,
        store: {
          ...intents.store,
          put: () => Effect.fail(storageError),
          remove: () => Effect.fail(storageError),
        },
      },
    });
    return Effect.gen(function* () {
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      yield* tracker.start(startInput, harness.hooks).pipe(Effect.flip);
      expect(yield* tracker.get(projectId)).toBeNull();
      const second = yield* tracker.start(startInput, harness.hooks).pipe(Effect.flip);
      expect(second.message).toContain("Storage unavailable");
      expect(second.message).not.toContain("already in progress");
      expect(harness.created).toEqual([]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("finishes admitting a retry when its requesting client disconnects", () => {
    const entered = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    const cloned = Deferred.makeUnsafe<void>();
    const intents = makeIntentStore([initialIntent]);
    const harness = makeHarness({
      intents: {
        ...intents,
        store: {
          ...intents.store,
          put: (intent) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              yield* intents.store.put(intent);
            }),
        },
      },
      clone: () =>
        Deferred.succeed(cloned, undefined).pipe(
          Effect.as({
            cwd: startInput.destinationPath,
            remoteUrl: startInput.remoteUrl,
            repository: null,
          }),
        ),
    });
    return Effect.gen(function* () {
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      const request = yield* tracker.retry(projectId).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const disconnected = yield* Fiber.interrupt(request).pipe(Effect.forkChild);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(disconnected);
      yield* Deferred.await(cloned);
      yield* tracker.stream.pipe(
        Stream.filter((entries) => entries[0]?.phase === "done"),
        Stream.take(1),
        Stream.runDrain,
      );
      expect(intents.saved.size).toBe(0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "retries completion persistence without cloning again or deleting successful output",
    () => {
      const intents = makeIntentStore();
      let removeCalls = 0;
      let cloneCalls = 0;
      const harness = makeHarness({
        intents: {
          ...intents,
          store: {
            ...intents.store,
            remove: (id) =>
              Effect.suspend(() => {
                removeCalls += 1;
                return removeCalls === 1
                  ? Effect.fail(
                      new SourceControlRepositoryError({
                        operation: "removeCloneRecovery",
                        provider: "unknown",
                        detail: "Disk is full.",
                      }),
                    )
                  : intents.store.remove(id);
              }),
          },
        },
        clone: () =>
          Effect.sync(() => {
            cloneCalls += 1;
            return {
              cwd: startInput.destinationPath,
              remoteUrl: startInput.remoteUrl,
              repository: null,
            };
          }),
      });
      return Effect.gen(function* () {
        const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
        yield* tracker.start(startInput, harness.hooks);
        yield* tracker.stream.pipe(
          Stream.filter((entries) => entries[0]?.phase === "failed"),
          Stream.take(1),
          Stream.runDrain,
        );
        expect((yield* tracker.get(projectId))?.error).toContain("Your files are safe");
        expect(intents.saved.size).toBe(1);
        yield* tracker.retry(projectId);
        expect((yield* tracker.get(projectId))?.phase).toBe("done");
        expect(intents.saved.size).toBe(0);
        expect(cloneCalls).toBe(1);
        expect(harness.discarded).toEqual([]);
      }).pipe(Effect.provide(harness.layer));
    },
  );
});

describe("parseGitCloneProgressLine", () => {
  it("parses git's transfer counters and ignores other output", () => {
    expect(
      parseGitCloneProgressLine("Receiving objects:  45% (4500/10000), 12.30 MiB | 5.00 MiB/s"),
    ).toEqual({ stage: "receiving", percent: 45, detail: "12.30 MiB | 5.00 MiB/s" });
    expect(parseGitCloneProgressLine("Resolving deltas: 100% (700/700), done.")).toEqual({
      stage: "resolving",
      percent: 100,
      detail: null,
    });
    expect(parseGitCloneProgressLine("remote: Compressing objects:  12% (3/25)")).toEqual({
      stage: "counting",
      percent: 12,
      detail: null,
    });
    expect(parseGitCloneProgressLine("Updating files:  78% (2104/2700)")).toEqual({
      stage: "checkout",
      percent: 78,
      detail: null,
    });
    expect(parseGitCloneProgressLine("remote: Enumerating objects: 10, done.")).toEqual({
      stage: "counting",
      percent: null,
      detail: null,
    });
    expect(parseGitCloneProgressLine("Cloning into 't3code'...")).toBeNull();
    expect(parseGitCloneProgressLine("fatal: repository not found")).toBeNull();
  });
});
