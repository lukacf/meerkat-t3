import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type MeerkatPendingQuestion,
} from "@t3tools/contracts";
import {
  act,
  type ButtonHTMLAttributes,
  type PropsWithChildren,
  type ReactElement,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../ui/button", () => ({
  Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("../ui/textarea", () => ({
  Textarea: (props: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} />,
}));
vi.mock("../ui/dialog", async () => {
  const { cloneElement, createContext, useContext, useMemo } = await import("react");
  const Context = createContext({ open: false, onOpenChange: (_open: boolean) => {} });
  const Container = ({ children }: PropsWithChildren) => <div>{children}</div>;
  return {
    Dialog: ({
      open,
      onOpenChange,
      children,
    }: PropsWithChildren<{ open: boolean; onOpenChange: (open: boolean) => void }>) => {
      const value = useMemo(() => ({ open, onOpenChange }), [open, onOpenChange]);
      return <Context value={value}>{children}</Context>;
    },
    DialogTrigger: ({ children }: PropsWithChildren) => {
      const context = useContext(Context);
      return <button onClick={() => context.onOpenChange(true)}>{children}</button>;
    },
    DialogPopup: ({
      render,
      children,
    }: {
      render: ReactElement<{ children?: ReactNode }>;
      children: ReactNode;
    }) => (useContext(Context).open ? cloneElement(render, {}, children) : null),
    DialogHeader: Container,
    DialogTitle: Container,
    DialogDescription: Container,
    DialogPanel: Container,
    DialogFooter: Container,
  };
});

import { AgentQuestionCard } from "./AgentQuestionCard";
import { nativeQuestionDraftKey, type NativeQuestionDraftScope } from "./nativeQuestionDraftStore";

const scope: NativeQuestionDraftScope = {
  environmentId: EnvironmentId.make("environment"),
  projectId: ProjectId.make("project"),
  instanceId: ProviderInstanceId.make("meerkat"),
};
let saved = new Map<string, string>();
const storage = {
  getItem: vi.fn((key: string) => saved.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => {
    saved.set(key, value);
  }),
  removeItem: vi.fn((key: string) => {
    saved.delete(key);
  }),
};

const request = (
  requestId: string,
  questionIds: string[],
  sessionId = "session",
): MeerkatPendingQuestion => ({
  requestId,
  sessionId,
  mobId: "mob",
  toolCallId: `tool-${requestId}`,
  createdAt: "2026-09-29T07:00:00.000Z",
  title: `Question ${requestId}`,
  questions: questionIds.map((id) => ({
    id,
    question: `Choose ${id}`,
    options: [{ id: "yes", label: "Yes", description: "" }],
    allowCustom: true,
    multiSelect: false,
  })),
});

let renderer: ReactTestRenderer | undefined;
const answer = vi.fn<(answers: unknown, dismissed: boolean) => Promise<string | null>>();
const button = (label: string) =>
  renderer!.root.findAllByType("button").find((node) => node.children.includes(label))!;
const render = (value: MeerkatPendingQuestion, draftScope = scope, disabledReason?: string) => {
  act(() => {
    const element = (
      <AgentQuestionCard
        request={value}
        draftScope={draftScope}
        onAnswer={answer}
        {...(disabledReason ? { disabledReason } : {})}
      />
    );
    if (renderer) renderer.update(element);
    else renderer = create(element);
  });
};
const open = () => act(() => button("Answer question").props.onClick());
const writeAnswer = (index: number, text: string) =>
  act(() => {
    renderer!.root.findAllByType("textarea")[index]!.props.onChange({
      target: { value: text },
    });
  });
const submit = () =>
  act(async () => {
    renderer!.root.findByType("form").props.onSubmit({ preventDefault: () => {} });
  });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  saved = new Map();
  storage.getItem.mockReset().mockImplementation((key) => saved.get(key) ?? null);
  storage.setItem.mockReset().mockImplementation((key, value) => {
    saved.set(key, value);
  });
  storage.removeItem.mockReset().mockImplementation((key) => {
    saved.delete(key);
  });
  vi.stubGlobal("localStorage", storage);
  answer.mockReset().mockResolvedValue(null);
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("native question request transitions", () => {
  it("restores a partial draft after navigation/reload without answering it", () => {
    const value = request("partial", ["one", "two"]);
    render(value);
    open();
    writeAnswer(0, "First partial answer");
    act(() =>
      renderer!.root.findAllByType("input")[0]!.props.onChange({ target: { checked: true } }),
    );
    act(() => renderer!.unmount());
    renderer = undefined;
    render(value);
    expect(answer).not.toHaveBeenCalled();
    open();
    expect(renderer!.root.findAllByType("textarea").map((node) => node.props.value)).toEqual([
      "First partial answer",
      "",
    ]);
    expect(renderer!.root.findAllByType("input").map((node) => node.props.checked)).toEqual([
      true,
      false,
    ]);
    expect(button("Send answers").props.disabled).toBe(true);
    expect(JSON.stringify(renderer!.toJSON())).toContain("Draft saved on this device");
  });

  it("retains a failed answer across reload and clears only a confirmed submission", async () => {
    const value = request("a", ["choice"]);
    answer.mockResolvedValueOnce("The answer was not accepted");
    render(value);
    open();
    writeAnswer(0, "Keep on failure");
    await submit();
    expect(saved.has(nativeQuestionDraftKey(scope, value))).toBe(true);
    act(() => renderer!.unmount());
    renderer = undefined;
    render(value);
    open();
    expect(renderer!.root.findByType("textarea").props.value).toBe("Keep on failure");
    await submit();
    expect(saved.has(nativeQuestionDraftKey(scope, value))).toBe(false);
    expect(answer).toHaveBeenCalledTimes(2);
  });

  it("starts blank after content/schema or environment changes and retains the earlier draft", () => {
    const value = request("a", ["choice"]);
    render(value);
    open();
    writeAnswer(0, "For original question only");
    const changed = {
      ...value,
      questions: value.questions.map((question) => ({
        ...question,
        question: "A different question?",
      })),
    };
    render(changed);
    open();
    expect(renderer!.root.findByType("textarea").props.value).toBe("");
    render(value, { ...scope, environmentId: EnvironmentId.make("elsewhere") });
    open();
    expect(renderer!.root.findByType("textarea").props.value).toBe("");
    render(value);
    open();
    expect(renderer!.root.findByType("textarea").props.value).toBe("For original question only");
    expect(answer).not.toHaveBeenCalled();
  });

  it("keeps edits visible when storage fails and saves the unchanged draft on retry", () => {
    render(request("a", ["choice"]));
    open();
    storage.setItem.mockImplementationOnce(() => {
      throw new Error("Unavailable");
    });
    writeAnswer(0, "Keep in this view");
    expect(JSON.stringify(renderer!.toJSON())).toContain("Answers are only in this view");
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("Draft saved on this device");
    act(() => button("Retry saving").props.onClick());
    expect(renderer!.root.findByType("textarea").props.value).toBe("Keep in this view");
    expect(JSON.stringify(renderer!.toJSON())).toContain("Draft saved on this device");
    expect(answer).not.toHaveBeenCalled();
  });

  it("discards a local draft explicitly without dismissing the native question", () => {
    const value = request("a", ["choice"]);
    render(value);
    open();
    writeAnswer(0, "Local draft");
    act(() => button("Discard draft").props.onClick());
    expect(renderer!.root.findByType("textarea").props.value).toBe("");
    expect(saved.has(nativeQuestionDraftKey(scope, value))).toBe(false);
    expect(answer).not.toHaveBeenCalled();
  });

  it("clears the draft after confirmed dismissal and preserves it through transient absence", async () => {
    const value = request("a", ["choice"]);
    render(value);
    open();
    writeAnswer(0, "Partial answer");
    act(() => renderer!.update(<div>Questions unavailable</div>));
    expect(saved.has(nativeQuestionDraftKey(scope, value))).toBe(true);
    render(value);
    open();
    expect(renderer!.root.findByType("textarea").props.value).toBe("Partial answer");
    await act(async () => button("Dismiss").props.onClick());
    expect(answer).toHaveBeenCalledExactlyOnceWith(
      [{ questionId: "choice", selectedOptionIds: [], customText: "Partial answer" }],
      true,
    );
    expect(saved.has(nativeQuestionDraftKey(scope, value))).toBe(false);
  });

  it("retries failed confirmed cleanup without sending the answer again", async () => {
    render(request("a", ["choice"]));
    open();
    writeAnswer(0, "Confirmed answer");
    storage.removeItem.mockImplementationOnce(() => {
      throw new Error("Unavailable");
    });
    await submit();
    expect(JSON.stringify(renderer!.toJSON())).toContain("Answers were accepted");
    expect(button("Send answers").props.disabled).toBe(true);
    await submit();
    expect(answer).toHaveBeenCalledOnce();
    act(() => button("Retry clearing saved draft").props.onClick());
    expect(saved.size).toBe(0);
    expect(answer).toHaveBeenCalledOnce();
  });

  it("does not clear newer same-request edits when an earlier mounted submission completes", async () => {
    const value = request("a", ["choice"]);
    let finish: (result: string | null) => void = () => {};
    answer.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(value);
    open();
    writeAnswer(0, "Original submission");
    await submit();
    act(() => renderer!.unmount());
    renderer = undefined;
    render(value);
    open();
    writeAnswer(0, "New local edits");
    await act(async () => finish(null));
    expect(renderer!.root.findByType("textarea").props.value).toBe("New local edits");
    act(() => renderer!.unmount());
    renderer = undefined;
    render(value);
    open();
    expect(renderer!.root.findByType("textarea").props.value).toBe("New local edits");
  });

  it("does not submit a captured form after the current restore guard blocks it", async () => {
    const value = request("a", ["choice"]);
    render(value);
    open();
    writeAnswer(0, "Keep while held");
    const formSubmit = renderer!.root.findByType("form").props.onSubmit;
    render(value, scope, "Review the restored profile first.");
    await act(async () => formSubmit({ preventDefault: () => {} }));
    expect(answer).not.toHaveBeenCalled();
    expect(saved.has(nativeQuestionDraftKey(scope, value))).toBe(true);
  });

  it("preserves entered answers when the same request refreshes", async () => {
    render(request("a", ["first"]));
    open();
    writeAnswer(0, "Keep this answer");

    render(request("a", ["first"]));
    expect(renderer!.root.findByType("textarea").props.value).toBe("Keep this answer");
    await submit();

    expect(answer).toHaveBeenCalledExactlyOnceWith(
      [{ questionId: "first", selectedOptionIds: [], customText: "Keep this answer" }],
      false,
    );
  });

  it("starts a new request with fresh answers even when it has more questions", async () => {
    render(request("a", ["old"]));
    open();
    writeAnswer(0, "Only for request A");
    act(() => renderer!.root.findByType("input").props.onChange({ target: { checked: true } }));

    render(request("b", ["first-new", "second-new"]));
    open();
    expect(renderer!.root.findAllByType("textarea").map((node) => node.props.value)).toEqual([
      "",
      "",
    ]);
    expect(renderer!.root.findAllByType("input").map((node) => node.props.checked)).toEqual([
      false,
      false,
    ]);
    expect(button("Send answers").props.disabled).toBe(true);
    writeAnswer(0, "First B answer");
    writeAnswer(1, "Second B answer");
    await submit();

    expect(answer).toHaveBeenCalledExactlyOnceWith(
      [
        { questionId: "first-new", selectedOptionIds: [], customText: "First B answer" },
        { questionId: "second-new", selectedOptionIds: [], customText: "Second B answer" },
      ],
      false,
    );
  });

  it("does not reuse an answer when the session changes with the same request ID", () => {
    render(request("same-id", ["choice"], "session-a"));
    open();
    writeAnswer(0, "Only for session A");

    render(request("same-id", ["choice"], "session-b"));
    open();
    expect(renderer!.root.findByType("textarea").props.value).toBe("");
    expect(button("Send answers").props.disabled).toBe(true);
  });

  it("does not send the same pending answer twice before React updates the button", async () => {
    let complete: (value: string | null) => void = () => {};
    answer.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    render(request("a", ["choice"]));
    open();
    writeAnswer(0, "One answer");
    act(() => {
      const form = renderer!.root.findByType("form");
      form.props.onSubmit({ preventDefault: () => {} });
      form.props.onSubmit({ preventDefault: () => {} });
    });
    expect(answer).toHaveBeenCalledOnce();
    await act(async () => complete(null));
  });

  it.each([null, "The earlier question expired"])(
    "does not apply a delayed earlier result (%s) to the new request",
    async (failure) => {
      let resolveFirst: (value: string | null) => void = () => {};
      answer.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      );
      render(request("a", ["old"]));
      open();
      writeAnswer(0, "Answer A");
      await submit();

      render(request("b", ["new"]));
      open();
      writeAnswer(0, "Answer B");
      await act(async () => resolveFirst(failure));

      expect(renderer!.root.findByType("textarea").props.value).toBe("Answer B");
      expect(button("Send answers").props.disabled).toBe(false);
      expect(renderer!.root.findAllByProps({ role: "alert" })).toHaveLength(0);
      await submit();
      expect(answer).toHaveBeenLastCalledWith(
        [{ questionId: "new", selectedOptionIds: [], customText: "Answer B" }],
        false,
      );
    },
  );
});
