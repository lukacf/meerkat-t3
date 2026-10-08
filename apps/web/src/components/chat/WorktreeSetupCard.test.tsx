import { ThreadId, type WorktreeSetupSnapshot, type WorktreeSetupStage } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("~/components/ui/button", () => ({ Button: "button" }));
import { WorktreeSetupCard } from "./WorktreeSetupCard";

const startedAt = "2026-10-04T21:46:26.000Z";
const endedAt = "2026-10-04T21:46:27.000Z";
const stage = (
  id: WorktreeSetupStage["id"],
  status: WorktreeSetupStage["status"],
): WorktreeSetupStage => ({
  id,
  status,
  startedAt,
  endedAt,
  percent: null,
  detail: null,
  tail: [],
});
const snapshot: WorktreeSetupSnapshot = {
  threadId: ThreadId.make("prepared-thread"),
  phase: "failed",
  sequence: 8,
  startedAt,
  endedAt,
  branch: "prepared-branch",
  baseRef: "main",
  worktreePath: "/project/prepared-checkout",
  setupScript: { name: "Install", command: "install-dependencies", terminalId: "setup-terminal" },
  stages: [stage("checkout", "done"), stage("setup-script", "done"), stage("agent", "failed")],
  error: "Original checkout model unavailable",
};
let renderer: ReactTestRenderer | undefined;
const button = (label: string) =>
  renderer!.root.findAllByType("button").find((entry) => entry.children.includes(label))!;

beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("initial worktree setup history", () => {
  it("keeps the failed initial agent handoff distinct from checkout setup, with its evidence accessible", async () => {
    const onOpenTerminal = vi.fn();
    await act(async () => {
      renderer = create(
        <WorktreeSetupCard
          snapshot={snapshot}
          onCancel={null}
          onWorkLocally={null}
          onOpenTerminal={onOpenTerminal}
        />,
      );
    });
    expect(
      renderer!.root
        .findAllByType("span")
        .some((entry) => entry.children.includes("Initial agent start failed")),
    ).toBe(true);
    expect(renderer!.root.findByType("p").children).toEqual(["Initial attempt: ", snapshot.error]);
    expect(renderer!.root.findAllByType("dl")).toHaveLength(0);
    await act(async () => button("Details").props.onClick());
    expect(
      renderer!.root
        .findByType("dl")
        .findAllByType("dd")
        .some((entry) => entry.children.includes("install-dependencies")),
    ).toBe(true);
    await act(async () => button("Open terminal").props.onClick());
    expect(onOpenTerminal).toHaveBeenCalledTimes(1);
    expect(snapshot.stages.find((entry) => entry.id === "setup-script")?.status).toBe("done");
    expect(
      renderer!.root.findAllByType("button").some((entry) => entry.children.includes("Cancel")),
    ).toBe(false);
  });

  it("preserves failed setup script history beneath a subsequent live turn", async () => {
    const failedScript = {
      ...snapshot,
      phase: "done" as const,
      error: null,
      stages: [stage("checkout", "done"), stage("setup-script", "failed"), stage("agent", "done")],
    };
    const onOpenTerminal = vi.fn();
    await act(async () => {
      renderer = create(
        <WorktreeSetupCard
          snapshot={failedScript}
          embedded
          onCancel={null}
          onWorkLocally={null}
          onOpenTerminal={onOpenTerminal}
        />,
      );
    });
    expect(
      renderer!.root
        .findAllByType("span")
        .some((entry) => entry.children.includes("Worktree ready, initial setup script failed")),
    ).toBe(true);
    await act(async () => button("Details").props.onClick());
    expect(renderer!.root.findAllByType("dl")).toHaveLength(1);
    await act(async () => button("Open terminal").props.onClick());
    expect(onOpenTerminal).toHaveBeenCalledTimes(1);
    expect(failedScript.stages.find((entry) => entry.id === "setup-script")?.status).toBe("failed");
  });
});
