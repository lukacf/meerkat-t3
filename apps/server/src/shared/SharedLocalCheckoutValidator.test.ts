import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type SharedDelegationContext,
  type SharedDelegationRegisterInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { captureSharedCheckoutPatch } from "./SharedCheckoutPatch.ts";
import { makeSharedLocalCheckoutValidator } from "./SharedLocalCheckoutValidator.ts";
import { sharedGitEnvironment } from "./sharedGitEnvironment.ts";

const testLayer = VcsProcess.layer.pipe(Layer.provideMerge(NodeServices.layer));
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcs = yield* VcsProcess.VcsProcess;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "shared-admission-test-" });
  const git = (args: string[]) =>
    vcs
      .run({
        operation: "test",
        command: "git",
        args,
        cwd: root,
        env: sharedGitEnvironment(),
        timeoutMs: 5_000,
        maxOutputBytes: 1_048_576,
        outputMode: "error",
      })
      .pipe(Effect.map((value) => value.stdout.trim()));
  yield* git(["init", "-q", "-b", "feature"]);
  yield* git(["config", "user.name", "Fixture"]);
  yield* git(["config", "user.email", "fixture@example.invalid"]);
  const write = (value: string) => fs.writeFileString(path.join(root, "source.ts"), value);
  yield* write("base\n");
  yield* git(["add", "."]);
  yield* git(["commit", "-qm", "base"]);
  const commit = yield* git(["rev-parse", "HEAD"]);
  const binding = {
    environmentId: EnvironmentId.make("local"),
    projectId: ProjectId.make("project"),
    threadId: ThreadId.make("task"),
    instanceId: ProviderInstanceId.make("meerkat"),
    mobId: "mob",
    sessionId: "session",
  };
  const proof: SharedDelegationContext = {
    checkout: {
      checkoutId: "checkout",
      participantId: "owner",
      sharedProjectId: "project",
      localEnvironmentId: binding.environmentId,
      localProjectId: binding.projectId,
      repository: "github.com/example/repo",
      createdAt: "2026-10-17T00:00:00.000Z",
    },
    context: {
      contextId: "context",
      contextVersion: "version",
      checkoutId: "checkout",
      participantId: "owner",
      sharedProjectId: "project",
      source: { kind: "thread", threadId: binding.threadId },
      objective: "Review",
      revision: { branch: "feature", commit, applicability: "branch" },
      paths: [],
      tags: [],
      updatedAt: "2026-10-17T00:00:00.000Z",
    },
    snapshot: null,
  };
  const registration: SharedDelegationRegisterInput = {
    requestId: "request",
    label: "task",
    binding,
    contextId: "context",
    contextVersion: "version",
    actions: ["inbox.list"],
    expiresAt: "2026-10-17T01:00:00.000Z",
  };
  const connection = {
    origin: "https://shared.invalid",
    credential: "private",
    expected: {
      environmentId: EnvironmentId.make("remote"),
      workspaceId: "workspace",
      participantId: "owner",
    },
  };
  const validate = (value = proof) =>
    makeSharedLocalCheckoutValidator({ context: () => Effect.succeed(value) }).pipe(
      Effect.provideService(ProjectionSnapshotQuery, {
        getProjectShellById: () =>
          Effect.succeedSome({ id: binding.projectId, workspaceRoot: "/wrong-project-root" }),
        getThreadShellById: () =>
          Effect.succeedSome({
            id: binding.threadId,
            projectId: binding.projectId,
            archivedAt: null,
            worktreePath: root,
          }),
      } as never),
      Effect.flatMap((validator) => validator(connection, registration)),
    );
  const dirtyProof = Effect.gen(function* () {
    yield* write("dirty captured work\n");
    const preview = yield* captureSharedCheckoutPatch(
      { projectId: binding.projectId, threadId: binding.threadId },
      root,
    );
    assert.strictEqual(preview.status, "ready");
    return {
      ...proof,
      context: {
        ...proof.context,
        revision: { ...proof.context.revision, snapshotId: "snapshot" },
      },
      snapshot: {
        snapshotId: "snapshot",
        checkoutId: "checkout",
        sharedProjectId: "project",
        revision: proof.context.revision,
        sha256: preview.sha256!,
        bytes: preview.bytes,
        createdAt: "2026-10-17T00:00:00.000Z",
      },
    } satisfies SharedDelegationContext;
  });
  return { proof, validate, dirtyProof, write };
});

it.effect(
  "accepts the exact clean task worktree and authenticated matching retained dirty snapshot",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.validate();
      const dirty = yield* f.dirtyProof;
      yield* f.validate(dirty);
      yield* f.write("changed after upload\n");
      assert.strictEqual((yield* f.validate(dirty).pipe(Effect.flip)).code, "conflict");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("does not authorize dirty work using an opaque snapshot ID or clean context", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const dirty = yield* f.dirtyProof;
    for (const proof of [
      f.proof,
      { ...dirty, snapshot: null },
      { ...dirty, snapshot: { ...dirty.snapshot, sha256: "a".repeat(64) } },
    ])
      assert.strictEqual((yield* f.validate(proof).pipe(Effect.flip)).code, "conflict");
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("rejects foreign participant, checkout, task, context and snapshot revision proofs", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const dirty = yield* f.dirtyProof;
    for (const proof of [
      { ...dirty, checkout: { ...dirty.checkout, participantId: "other" } },
      { ...dirty, checkout: { ...dirty.checkout, checkoutId: "other" } },
      {
        ...dirty,
        checkout: { ...dirty.checkout, localEnvironmentId: EnvironmentId.make("other") },
      },
      { ...dirty, context: { ...dirty.context, contextVersion: "other" } },
      {
        ...dirty,
        context: {
          ...dirty.context,
          source: { kind: "thread" as const, threadId: ThreadId.make("other") },
        },
      },
      { ...dirty, snapshot: { ...dirty.snapshot, checkoutId: "other" } },
      {
        ...dirty,
        snapshot: {
          ...dirty.snapshot,
          revision: { ...dirty.snapshot.revision, commit: "b".repeat(40) },
        },
      },
    ])
      assert.strictEqual((yield* f.validate(proof).pipe(Effect.flip)).code, "conflict");
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);
