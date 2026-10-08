import { EnvironmentId, type ProjectReadFileResult } from "@t3tools/contracts";
import type { OptimisticProjectFile } from "@t3tools/client-runtime/state/projects";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  optimisticFile: vi.fn(),
  registry: null as AtomRegistry.AtomRegistry | null,
}));
vi.mock("~/state/projects", () => ({ projectEnvironment: mocks }));
vi.mock("~/state/queries", () => ({ useProjectPathSearch: vi.fn() }));
vi.mock("~/rpc/atomRegistry", () => ({
  get appAtomRegistry() {
    return mocks.registry;
  },
}));

import { hasPendingProjectFileEdit, refreshRestoredProjectFile } from "./projectFilesQueryState";

const environmentId = EnvironmentId.make("restored-file-query");
function file(contents: string): ProjectReadFileResult {
  return { relativePath: "file.txt", contents, byteLength: contents.length, truncated: false };
}

afterEach(() => {
  mocks.registry?.dispose();
  mocks.registry = null;
  mocks.readFile.mockReset();
  mocks.optimisticFile.mockReset();
});

describe("restored file read-back", () => {
  it("replaces a read started before restore and waits for the new contents", async () => {
    const reads: Array<(contents: ProjectReadFileResult) => void> = [];
    const read = Atom.make(
      Effect.promise(
        () =>
          new Promise<ProjectReadFileResult>((resolve) => {
            reads.push(resolve);
          }),
      ),
    );
    const optimistic = Atom.make<OptimisticProjectFile | null>(null);
    mocks.registry = AtomRegistry.make();
    mocks.readFile.mockReturnValue(read);
    mocks.optimisticFile.mockReturnValue(optimistic);
    const unmount = mocks.registry.mount(read);
    await Promise.resolve();
    const beforeRestore = reads[0]!;
    const refreshed = refreshRestoredProjectFile(environmentId, "/repo", "file.txt");
    await Promise.resolve();
    expect(reads).toHaveLength(2);
    reads[1]!(file("restored"));
    await refreshed;
    beforeRestore(file("stale"));
    await Promise.resolve();
    expect(Option.getOrNull(AsyncResult.value(mocks.registry.get(read)))?.contents).toBe(
      "restored",
    );
    unmount();
  });

  it("reads restored contents and clears an older confirmed save overlay", async () => {
    const read = Atom.make(Effect.succeed(file("restored")));
    const optimistic = Atom.make<OptimisticProjectFile | null>({
      data: file("before restore"),
      confirmedAgainst: {},
    });
    mocks.registry = AtomRegistry.make();
    mocks.readFile.mockReturnValue(read);
    mocks.optimisticFile.mockReturnValue(optimistic);
    expect(hasPendingProjectFileEdit(environmentId, "/repo", "file.txt")).toBe(false);
    await refreshRestoredProjectFile(environmentId, "/repo", "file.txt");
    expect(Option.getOrNull(AsyncResult.value(mocks.registry.get(read)))?.contents).toBe(
      "restored",
    );
    expect(mocks.registry.get(optimistic)).toBeNull();
  });

  it("does not discard unconfirmed local contents when refreshing disk data", async () => {
    const read = Atom.make(Effect.succeed(file("disk")));
    const pending: OptimisticProjectFile = { data: file("unsaved"), confirmedAgainst: undefined };
    const optimistic = Atom.make<OptimisticProjectFile | null>(pending);
    mocks.registry = AtomRegistry.make();
    mocks.readFile.mockReturnValue(read);
    mocks.optimisticFile.mockReturnValue(optimistic);
    expect(hasPendingProjectFileEdit(environmentId, "/repo", "file.txt")).toBe(true);
    await refreshRestoredProjectFile(environmentId, "/repo", "file.txt");
    expect(mocks.registry.get(optimistic)).toBe(pending);
  });
});
