import {
  ProjectId,
  ProviderInstanceId,
  type MeerkatAttentionItem,
  type ConsoleFrame,
} from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { isCurrentNativeQuestion, pendingNativeQuestionCalls } from "./nativeQuestionStatus";
import type { ConversationActivity } from "./agentActivity.logic";

const target = {
  projectId: "project",
  instanceId: "provider",
  agentRef: "agent",
  sessionId: "session",
  mobId: "mob",
};
const item: MeerkatAttentionItem = {
  id: "attention",
  projectId: ProjectId.make("project"),
  instanceId: ProviderInstanceId.make("provider"),
  agentRef: "agent",
  sessionId: "session",
  projectAgentId: "specialist",
  threadId: null,
  coordinator: false,
  label: "Reviewer",
  kind: "question",
  title: "Choose",
  detail: "Answer needed",
  question: {
    requestId: "request",
    sessionId: "session",
    mobId: "mob",
    toolCallId: "call",
    title: "Choose",
    questions: [],
    createdAt: "2026-10-01T12:00:00.000Z",
  },
  completionStatus: null,
  active: true,
  unread: false,
  createdAt: "2026-10-01T12:00:00.000Z",
  updatedAt: "2026-10-01T12:00:00.000Z",
};
const frame: ConsoleFrame = {
  id: "frame",
  cursor: "1",
  dedupe_key: "frame",
  timestamp_ms: 1,
  runtime_key: "runtime",
  identity: "member",
  session_id: "session",
  run_id: "run",
  kind: "tool_execution_started",
  status: "accepted",
  frame_version: 1,
  source: { kind: "console_event" },
  payload: { tool_call_id: "call", name: "ui_multiple_choice" },
};
const activity: Extract<ConversationActivity, { kind: "tool" }> = {
  kind: "tool",
  id: "tool",
  label: "Ui multiple choice",
  status: "Running",
  frames: [frame],
  input: "",
  output: "",
};

it("requires an active native question for the exact target even after it is read", () => {
  expect([...pendingNativeQuestionCalls([item], target)]).toEqual(["call"]);
  for (const key of ["projectId", "instanceId", "agentRef", "sessionId", "mobId"] as const)
    expect(pendingNativeQuestionCalls([item], { ...target, [key]: "other" }).size).toBe(0);
  expect(pendingNativeQuestionCalls([item], { ...target, sessionId: undefined }).size).toBe(0);
  for (const other of [
    { ...item, active: false },
    { ...item, kind: "completion" as const },
    { ...item, question: null },
    { ...item, question: { ...item.question!, sessionId: "replacement" } },
  ])
    expect(pendingNativeQuestionCalls([other], target).size).toBe(0);
});

it("changes the current question presentation only for its live native run and exact call", () => {
  const calls = pendingNativeQuestionCalls([item], target);
  expect(isCurrentNativeQuestion(activity, "run", calls)).toBe(true);
  expect(isCurrentNativeQuestion(activity, "replacement", calls)).toBe(false);
  expect(isCurrentNativeQuestion(activity, undefined, calls)).toBe(false);
  expect(isCurrentNativeQuestion(activity, "run", new Set(["other-call"]))).toBe(false);
  expect(isCurrentNativeQuestion({ ...activity, status: "Completed" }, "run", calls)).toBe(false);
  expect(
    isCurrentNativeQuestion(
      { ...activity, frames: [{ ...frame, source: { kind: "session_history" } }] },
      "run",
      calls,
    ),
  ).toBe(false);
  expect(activity.status).toBe("Running");
  expect(activity.frames[0]).toBe(frame);
});
