import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type { OnboardingProgress } from "@t3tools/contracts/settings";
import {
  hasSuccessfulFirstReply,
  isFirstTaskLocation,
  isOnboardingTask,
  type FirstTaskEvidence,
} from "./firstTask.logic";

const progress: OnboardingProgress = {
  step: "first-task",
  environmentIds: [EnvironmentId.make("computer")],
  startedAt: "2026-10-04T10:00:00.000Z",
  projectRef: {
    environmentId: EnvironmentId.make("computer"),
    projectId: ProjectId.make("project"),
  },
  threadId: ThreadId.make("first-task"),
};
const reply: FirstTaskEvidence = {
  environmentId: "computer",
  projectId: "project",
  threadId: "first-task",
  latestTurn: {
    state: "completed",
    requestedAt: "2026-10-04T10:01:00.000Z",
    assistantMessageId: "answer",
  },
  messages: [
    { id: "answer", role: "assistant", text: "This project contains...", streaming: false },
  ],
};
describe("first task completion", () => {
  it("keeps first-task guidance on the bound task before its first turn", () => {
    expect(isFirstTaskLocation(progress, { ...reply, threadId: "first-task" })).toBe(true);
    expect(isFirstTaskLocation(progress, { ...reply, threadId: "another-task" })).toBe(false);
    expect(isFirstTaskLocation({ ...progress, threadId: null }, reply)).toBe(false);
    expect(isFirstTaskLocation(progress, { ...reply, environmentId: "another-computer" })).toBe(
      false,
    );
    expect(isFirstTaskLocation(progress, { ...reply, projectId: "another-project" })).toBe(false);
  });
  it("requires a real reply to a newly requested task", () => {
    expect(hasSuccessfulFirstReply(progress, reply)).toBe(true);
    expect(hasSuccessfulFirstReply(progress, { ...reply, threadId: null })).toBe(false);
    expect(hasSuccessfulFirstReply(progress, { ...reply, messages: [] })).toBe(false);
    expect(
      hasSuccessfulFirstReply(progress, {
        ...reply,
        messages: [{ id: "answer", role: "assistant", text: " " }],
      }),
    ).toBe(false);
  });
  it("does not count imported history, even from the chosen project", () => {
    expect(hasSuccessfulFirstReply({ ...progress, threadId: null }, reply)).toBe(false);
  });
  it("accepts a bound first task even when a remote computer clock is behind", () => {
    expect(
      hasSuccessfulFirstReply(progress, {
        ...reply,
        latestTurn: { ...reply.latestTurn!, requestedAt: "2026-10-03T10:00:00.000Z" },
      }),
    ).toBe(true);
  });
  it.each(["running", "error", "interrupted"])("keeps setup active after a %s turn", (state) => {
    expect(
      hasSuccessfulFirstReply(progress, { ...reply, latestTurn: { ...reply.latestTurn!, state } }),
    ).toBe(false);
  });
  it("ignores another thread or computer even when it has a completed answer", () => {
    const tracked = { ...progress, threadId: ThreadId.make("first-task") };
    expect(hasSuccessfulFirstReply(tracked, { ...reply, threadId: "another-task" })).toBe(false);
    expect(hasSuccessfulFirstReply(tracked, { ...reply, environmentId: "another-computer" })).toBe(
      false,
    );
    expect(hasSuccessfulFirstReply(tracked, { ...reply, projectId: "another-project" })).toBe(
      false,
    );
  });
  it("tracks a running first task for restart without declaring completion", () => {
    const running = { ...reply, latestTurn: { ...reply.latestTurn!, state: "running" } };
    expect(isOnboardingTask(progress, running)).toBe(true);
    expect(hasSuccessfulFirstReply(progress, running)).toBe(false);
  });
  it("does not count streamed partial text or unrelated assistant messages", () => {
    expect(
      hasSuccessfulFirstReply(progress, {
        ...reply,
        messages: [{ ...reply.messages[0]!, streaming: true }],
      }),
    ).toBe(false);
    expect(
      hasSuccessfulFirstReply(progress, {
        ...reply,
        latestTurn: { ...reply.latestTurn!, assistantMessageId: "different-answer" },
      }),
    ).toBe(false);
    expect(
      hasSuccessfulFirstReply(progress, {
        ...reply,
        messages: [{ ...reply.messages[0]!, role: "user" }],
      }),
    ).toBe(false);
  });
});
