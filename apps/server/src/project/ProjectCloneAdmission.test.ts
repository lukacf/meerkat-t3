import { expect, it } from "@effect/vitest";
import { ProjectId, ThreadId, type ProjectCloneSnapshot } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { rejectCommandsDuringClone, requireProjectCloneReady } from "./ProjectCloneTracker.ts";

const projectId = ProjectId.make("unfinished-clone");
const threadId = ThreadId.make("existing-thread");
const snapshot: ProjectCloneSnapshot = {
  projectId,
  remoteUrl: "/fixture/source.git",
  destinationPath: "/fixture/project",
  repository: null,
  phase: "failed",
  stage: "connecting",
  percent: null,
  detail: null,
  error: "Interrupted clone",
  startedAt: "2026-10-04T00:00:00.000Z",
  endedAt: null,
  sequence: 1,
};

for (const phase of ["running", "failed", "cancelled"] as const) {
  it.effect(`blocks project work while its clone is ${phase}`, () =>
    Effect.gen(function* () {
      let started = false;
      const tracker = { get: () => Effect.succeed({ ...snapshot, phase }) };
      const result = yield* requireProjectCloneReady(tracker, projectId).pipe(
        Effect.andThen(
          Effect.sync(() => {
            started = true;
          }),
        ),
        Effect.result,
      );
      expect(result._tag).toBe("Failure");
      expect(started).toBe(false);
    }),
  );
}

it.effect("resolves an existing thread's project before trusting a bootstrap project", () =>
  Effect.gen(function* () {
    const tracker = { get: (id: ProjectId) => Effect.succeed(id === projectId ? snapshot : null) };
    const error = yield* rejectCommandsDuringClone(
      tracker,
      {
        type: "thread.turn.start",
        threadId,
        bootstrap: { createThread: { projectId: ProjectId.make("ready-project") } },
      },
      (id) => {
        expect(id).toBe(threadId);
        return Effect.succeed(projectId);
      },
    ).pipe(Effect.flip);
    expect(error.message).toContain("Retry the clone first");
  }),
);

it.effect("uses a new thread's bootstrap project and leaves stopping available", () =>
  Effect.gen(function* () {
    const tracker = { get: () => Effect.succeed(snapshot) };
    yield* rejectCommandsDuringClone(
      tracker,
      {
        type: "thread.turn.start",
        threadId,
        bootstrap: { createThread: { projectId } },
      },
      () => Effect.succeed(null),
    ).pipe(Effect.flip);
    yield* rejectCommandsDuringClone(tracker, { type: "thread.turn.interrupt", threadId }, () =>
      Effect.die("Stopping must not require clone readiness"),
    );
    yield* requireProjectCloneReady({ get: () => Effect.succeed(null) }, projectId);
    yield* requireProjectCloneReady(
      { get: () => Effect.succeed({ ...snapshot, phase: "done" }) },
      projectId,
    );
  }),
);
