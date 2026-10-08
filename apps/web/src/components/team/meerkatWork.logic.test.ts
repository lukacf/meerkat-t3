import { describe, expect, it } from "vite-plus/test";
import {
  ProjectId,
  ProviderInstanceId,
  type MeerkatProjectTeam,
  type MeerkatTeamAgent,
} from "@t3tools/contracts";
import { meerkatWorkStatus, NativeCompletionTracker } from "./meerkatWork.logic";
const stamp = "2026-09-26T10:00:00.000Z";
const now = Date.parse(stamp);
const agent: MeerkatTeamAgent = {
  agentRef: "first",
  durableId: "logical",
  availability: "live",
  mobId: "mob",
  mobLabel: "Mob",
  mobKind: "domain",
  scopeLabel: "Project",
  record: {
    identity: "architect",
    display_name: "Architect",
    runtime_key: "default",
    runtime_member_id: "member",
    session_id: "session",
    addressable: true,
    visibility: "addressable",
    health: "ready",
    labels: {},
  },
  work: { status: "idle", observedAt: stamp },
};
const team = (agents: MeerkatTeamAgent[]): MeerkatProjectTeam => ({
  projectId: ProjectId.make("project"),
  observation: "loaded_runtimes",
  observedAt: stamp,
  projectAgents: [],
  providers: [
    {
      instanceId: ProviderInstanceId.make("meerkat"),
      label: "Meerkat",
      status: "ready",
      errors: [],
      totalScopeCount: 1,
      unloadedScopeCount: 0,
      loadedMobCount: 1,
      agents,
    },
  ],
});
const completed = (id: string, status: "completed" | "failed" = "completed"): MeerkatTeamAgent => ({
  ...agent,
  work: {
    status: "idle",
    observedAt: stamp,
    latestCompletion: { interactionId: id, timestampMs: now + 1, status },
  },
});
describe("native work status and notifications", () => {
  it("does not infer busy from health and expires old observations", () => {
    expect(meerkatWorkStatus({ ...agent, work: undefined }, now)).toBe("Status unknown");
    expect(meerkatWorkStatus(agent, now)).toBe("Idle");
    expect(meerkatWorkStatus(agent, now + 31_000)).toBe("Status stale");
    expect(meerkatWorkStatus({ ...agent, availability: "unloaded" }, now)).toBe("Unloaded");
  });
  it("baselines existing completions, dedupes by native interaction, then emits failure", () => {
    const tracker = new NativeCompletionTracker();
    expect(tracker.observe(team([completed("old")]))).toEqual([]);
    expect(tracker.observe(team([completed("new")]))).toHaveLength(1);
    expect(tracker.observe(team([completed("new")]))).toEqual([]);
    expect(tracker.observe(team([completed("failed", "failed")]))[0]?.status).toBe("failed");
  });
  it("deduplicates native run-start completions without inventing an interaction", () => {
    const tracker = new NativeCompletionTracker();
    tracker.observe(team([agent]));
    const native: MeerkatTeamAgent = {
      ...agent,
      work: {
        ...agent.work!,
        latestCompletion: {
          kind: "runtime_input",
          sessionId: "session",
          inputId: "input",
          runId: "run",
          status: "completed",
          timestampMs: now + 1,
        },
      },
    };
    expect(tracker.observe(team([native]))).toHaveLength(1);
    expect(tracker.observe(team([native]))).toEqual([]);
    expect(
      tracker.observe(
        team([{ ...native, record: { ...agent.record, session_id: "replacement" } }]),
      ),
    ).toEqual([]);
    expect(tracker.observe(team([completed("run")]))).toHaveLength(1);
  });
  it("does not flood after an unloaded agent becomes visible or a new session replaces it", () => {
    const tracker = new NativeCompletionTracker();
    expect(
      tracker.observe(
        team([
          { ...agent, availability: "unloaded", work: { status: "unloaded", observedAt: stamp } },
        ]),
      ),
    ).toEqual([]);
    expect(tracker.observe(team([completed("old")]))).toEqual([]);
    expect(
      tracker.observe(
        team([
          {
            ...completed("fresh"),
            agentRef: "replacement",
            record: { ...agent.record, session_id: "replacement" },
          },
        ]),
      ),
    ).toHaveLength(1);
    expect(
      tracker.observe(
        team([
          {
            ...completed("history"),
            work: {
              status: "idle",
              observedAt: stamp,
              latestCompletion: {
                interactionId: "ancient",
                timestampMs: now - 500,
                status: "completed",
              },
            },
          },
        ]),
      ),
    ).toEqual([]);
  });
});
