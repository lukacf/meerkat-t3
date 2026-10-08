import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type MeerkatPendingQuestion,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { createNativeQuestionDraft, nativeQuestionDraftKey } from "./nativeQuestionDraftStore";

const scope = {
  environmentId: EnvironmentId.make("environment"),
  projectId: ProjectId.make("project"),
  instanceId: ProviderInstanceId.make("meerkat"),
};
const request: MeerkatPendingQuestion = {
  sessionId: "session",
  requestId: "request",
  mobId: "mob",
  toolCallId: "tool",
  createdAt: "2026-10-04T07:00:00.000Z",
  title: "Choose an approach",
  questions: [
    {
      id: "choice",
      question: "Which approach?",
      multiSelect: true,
      allowCustom: true,
      options: [
        { id: "a", label: "A", description: "First" },
        { id: "b", label: "B", description: "Second" },
      ],
    },
    { id: "details", question: "Any details?", multiSelect: false, allowCustom: true, options: [] },
  ],
};
const answers = [
  { questionId: "choice", selectedOptionIds: ["b", "a"], customText: "  Keep spacing  " },
  { questionId: "details", selectedOptionIds: [], customText: "" },
];
const storage = () => {
  const values = new Map<string, string>();
  return {
    values,
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
  };
};

describe("native question local drafts", () => {
  it("restores partial choices and exact text in a new controller without clearing either", () => {
    const target = storage();
    const first = createNativeQuestionDraft(scope, request, () => target);
    expect(first.update(() => answers).saved).toBe(true);
    const restarted = createNativeQuestionDraft(scope, request, () => target);
    expect(restarted.getSnapshot()).toEqual({ answers, saved: true, error: null });
    expect(target.removeItem).not.toHaveBeenCalled();
  });

  it("isolates every native identity and content/schema change while preserving the old draft", () => {
    const target = storage();
    createNativeQuestionDraft(scope, request, () => target).update(() => answers);
    const variants = [
      [{ ...scope, environmentId: EnvironmentId.make("other") }, request],
      [{ ...scope, projectId: ProjectId.make("other") }, request],
      [{ ...scope, instanceId: ProviderInstanceId.make("other") }, request],
      [scope, { ...request, sessionId: "other" }],
      [scope, { ...request, requestId: "other" }],
      [scope, { ...request, mobId: "other" }],
      [scope, { ...request, toolCallId: "other" }],
      [scope, { ...request, createdAt: "2026-10-04T08:00:00.000Z" }],
      [scope, { ...request, title: "Changed title" }],
      [
        scope,
        {
          ...request,
          questions: request.questions.map((q) => ({ ...q, question: `${q.question} Changed` })),
        },
      ],
      [
        scope,
        { ...request, questions: request.questions.map((q) => ({ ...q, multiSelect: false })) },
      ],
      [
        scope,
        { ...request, questions: request.questions.map((q) => ({ ...q, allowCustom: false })) },
      ],
      [
        scope,
        {
          ...request,
          questions: request.questions.map((q) => ({
            ...q,
            options: q.options.map((o) => ({ ...o, label: "Different meaning" })),
          })),
        },
      ],
    ] as const;
    for (const [nextScope, nextRequest] of variants) {
      const draft = createNativeQuestionDraft(nextScope, nextRequest, () => target).getSnapshot();
      expect(
        draft.answers.every((answer) => !answer.customText && !answer.selectedOptionIds.length),
      ).toBe(true);
      expect(draft.saved).toBe(false);
    }
    expect(createNativeQuestionDraft(scope, request, () => target).getSnapshot().answers).toEqual(
      answers,
    );
    expect(target.removeItem).not.toHaveBeenCalled();
  });

  it("retains edits after storage failure and retries the unchanged value", () => {
    const target = storage();
    const draft = createNativeQuestionDraft(scope, request, () => target);
    target.setItem.mockImplementationOnce(() => {
      throw new Error("Quota exceeded");
    });
    expect(draft.update(() => answers)).toMatchObject({ answers, saved: false });
    expect(draft.getSnapshot().error).toContain("only in this view");
    expect(draft.retrySave()).toEqual({ answers, saved: true, error: null });
    expect(createNativeQuestionDraft(scope, request, () => target).getSnapshot().answers).toEqual(
      answers,
    );
  });

  it("requires verified storage readback before claiming a saved draft", () => {
    const target = storage();
    const draft = createNativeQuestionDraft(scope, request, () => target);
    target.setItem.mockImplementationOnce(() => {});
    expect(draft.update(() => answers).saved).toBe(false);
    expect(draft.getSnapshot().answers).toEqual(answers);
    expect(draft.retrySave().saved).toBe(true);
  });

  it("does not overwrite unreadable saved answers without explicit discard", () => {
    const target = storage();
    const key = nativeQuestionDraftKey(scope, request);
    target.values.set(key, "broken data");
    const draft = createNativeQuestionDraft(scope, request, () => target);
    expect(draft.getSnapshot().error).toContain("could not be read");
    expect(draft.update(() => answers).saved).toBe(false);
    expect(target.values.get(key)).toBe("broken data");
    expect(draft.discard().error).toBeNull();
    expect(target.values.has(key)).toBe(false);
    expect(draft.update(() => answers).saved).toBe(true);
  });

  it("fences stale-window edits and delayed accepted cleanup from a newer saved draft", () => {
    const target = storage();
    const first = createNativeQuestionDraft(scope, request, () => target);
    first.update(() => answers);
    const second = createNativeQuestionDraft(scope, request, () => target);
    const newer = answers.map((answer) => ({ ...answer, customText: "New draft" }));
    second.update(() => newer);
    expect(first.retrySave().saved).toBe(false);
    expect(first.clearConfirmed(answers)).toBe("changed");
    expect(createNativeQuestionDraft(scope, request, () => target).getSnapshot().answers).toEqual(
      newer,
    );
    expect(first.reload().answers).toEqual(newer);
    expect(first.clearConfirmed(newer)).toBe("cleared");
    expect(target.values.size).toBe(0);
  });

  it("retains saved evidence if confirmed cleanup or explicit discard fails", () => {
    const target = storage();
    const draft = createNativeQuestionDraft(scope, request, () => target);
    draft.update(() => answers);
    target.removeItem.mockImplementationOnce(() => {
      throw new Error("Unavailable");
    });
    expect(draft.clearConfirmed(answers)).toBe("unavailable");
    expect(createNativeQuestionDraft(scope, request, () => target).getSnapshot().answers).toEqual(
      answers,
    );
    target.removeItem.mockImplementationOnce(() => {});
    expect(draft.discard().error).toContain("could not be discarded");
    expect(draft.clearConfirmed(answers)).toBe("cleared");
  });
});
