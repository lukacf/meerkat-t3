import {
  ProjectId,
  ThreadId,
  ProviderInstanceId,
  type MeerkatProjectAgent,
  type MeerkatProjectAgentProposalCandidate,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  latestProposalAgent,
  proposalAssignmentMatches,
  proposalCandidateState,
  proposalPreparationSummary,
  proposalVisibleInThread,
} from "./projectAgentProposal.logic";

const candidate: MeerkatProjectAgentProposalCandidate = {
  id: "architecture",
  label: "Architect",
  role: "architecture",
  focus: "Runtime ownership",
  charter: "Own runtime lifecycle and its repository interfaces.",
  recommended: true,
  ownershipPaths: ["src/runtime", "tests/runtime.test.ts"],
};
const agent: MeerkatProjectAgent = {
  agentId: "agent",
  projectId: ProjectId.make("project"),
  instanceId: ProviderInstanceId.make("meerkat"),
  label: candidate.label,
  role: candidate.role,
  instructions: candidate.charter,
  focus: candidate.focus,
  charter: candidate.charter,
  ownershipPaths: [...candidate.ownershipPaths],
  model: "openai:model",
  enabled: true,
  archived: false,
  connectionStatus: "connected",
  error: null,
  agentRef: "native-agent",
  createdAt: "2026-09-25T18:00:00.000Z",
  updatedAt: "2026-09-25T18:00:00.000Z",
};
const prepared: MeerkatProjectAgent = {
  ...agent,
  preparation: {
    assignmentId: "study",
    fingerprint: "assignment",
    attempt: 1,
    status: "ready",
    requestId: "request",
    interactionId: "interaction",
    inputFrameId: "input",
    error: null,
    updatedAt: "2026-09-25T18:01:00.000Z",
  },
};

describe("project proposal preparation presentation", () => {
  it("does not equate connected creation with completed preparation", () => {
    expect(proposalCandidateState(candidate, agent)).toEqual({
      label: "Not prepared",
      actionable: true,
      retry: false,
    });
    expect(proposalCandidateState(candidate, prepared).label).toBe("Ready");
  });
  it("does not reuse readiness for a changed assignment", () => {
    expect(
      proposalCandidateState(
        { ...candidate, charter: "A different charter owns all compiler internals." },
        prepared,
      ),
    ).toEqual({ label: "Different assignment", actionable: false, retry: false });
    expect(
      proposalAssignmentMatches(
        { ...candidate, ownershipPaths: candidate.ownershipPaths.toReversed() },
        prepared,
      ),
    ).toBe(true);
  });
  it("requires an explicit retry after uncertain or interrupted study and never offers a duplicate active study", () => {
    for (const status of ["uncertain", "interrupted", "failed"] as const) {
      const state = proposalCandidateState(candidate, {
        ...prepared,
        preparation: { ...prepared.preparation!, status },
      });
      expect(state).toMatchObject({ actionable: false, retry: true });
    }
    expect(
      proposalCandidateState(candidate, {
        ...prepared,
        preparation: { ...prepared.preparation!, status: "studying" },
      }),
    ).toEqual({ label: "Studying domain", actionable: false, retry: false });
  });
  it("allows newer canonical preparation to supersede a creation receipt without losing an early receipt to stale polling", () => {
    const studying = {
      ...prepared,
      preparation: {
        ...prepared.preparation!,
        status: "studying" as const,
        updatedAt: "2026-09-25T18:00:30.000Z",
      },
    };
    expect(latestProposalAgent(agent, studying)).toEqual(studying);
    expect(latestProposalAgent(prepared, studying)).toEqual(prepared);
    const archived = { ...agent, archived: true, updatedAt: "2026-09-25T18:02:00.000Z" };
    expect(latestProposalAgent(archived, studying)).toEqual(archived);
    expect(proposalCandidateState(candidate, { ...prepared, archived: true })).toEqual({
      label: "Archived",
      actionable: false,
      retry: false,
    });
  });
});

describe("proposal preparation summary", () => {
  it("does not count optional unaccepted proposals as unfinished studies", () => {
    const result = proposalPreparationSummary([
      { candidate, agent: prepared },
      { candidate: { ...candidate, id: "optional", recommended: false }, agent: null },
    ]);
    expect(result).toMatchObject({
      accepted: 1,
      available: 1,
      ready: 1,
      failed: 0,
      allAcceptedReady: true,
      label: "1 agent ready",
    });
  });

  it("keeps failed, interrupted and uncertain studies visible after the dialog closes", () => {
    for (const status of ["failed", "interrupted", "uncertain"] as const) {
      expect(
        proposalPreparationSummary([
          { candidate, agent: { ...prepared, preparation: { ...prepared.preparation!, status } } },
        ]),
      ).toMatchObject({ failed: 1, ready: 0, allAcceptedReady: false, label: "1 needs attention" });
    }
  });

  it("distinguishes accepted revision waiting from readiness for the previous assignment", () => {
    const revision = {
      revisionId: "revision",
      requestId: "revise",
      version: 2,
      instructions: "A new assignment",
      focus: "New focus",
      charter: "New charter",
      ownershipPaths: ["new"],
      error: null,
      createdAt: prepared.updatedAt,
    };
    const proposed = { ...candidate, ...revision };
    expect(
      proposalPreparationSummary([
        { candidate: proposed, agent: { ...prepared, pendingRevision: revision } },
      ]),
    ).toMatchObject({ accepted: 1, ready: 0, allAcceptedReady: false, label: "1 awaiting study" });
    expect(proposalPreparationSummary([{ candidate: proposed, agent: prepared }])).toMatchObject({
      accepted: 0,
      ready: 0,
      label: "1 proposed",
    });
  });

  it("does not offer disabled or archived agents as ready and surfaces failed creation", () => {
    expect(
      proposalPreparationSummary([{ candidate, agent: { ...prepared, enabled: false } }]),
    ).toMatchObject({ available: 0, ready: 0, label: "1 disabled" });
    expect(
      proposalPreparationSummary([{ candidate, agent: { ...prepared, archived: true } }]),
    ).toMatchObject({ accepted: 0, available: 0, ready: 0 });
    expect(
      proposalPreparationSummary([{ candidate, agent: null, error: "Create failed" }]),
    ).toMatchObject({ failed: 1, available: 0, label: "1 needs attention" });
  });
});

describe("project proposal conversation ownership", () => {
  const threadId = ThreadId.make("setup-thread");
  it("does not present a busy ordinary conversation as a repository study", () => {
    expect(
      proposalVisibleInThread({ isSetupThread: false, sourceThreadId: threadId }, threadId),
    ).toBe(false);
  });
  it("requires the exact setup conversation and hides stale or absent data", () => {
    expect(
      proposalVisibleInThread({ isSetupThread: true, sourceThreadId: threadId }, threadId),
    ).toBe(true);
    expect(
      proposalVisibleInThread(
        { isSetupThread: true, sourceThreadId: ThreadId.make("other-thread") },
        threadId,
      ),
    ).toBe(false);
    expect(proposalVisibleInThread(null, threadId)).toBe(false);
  });
});
