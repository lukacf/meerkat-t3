import {
  EnvironmentId,
  type MeerkatAgentQueueItem,
  type ServerProviderSkill,
} from "@t3tools/contracts";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";
import { extractMeerkatConsoleSkillSelections } from "@t3tools/shared/meerkatSkills";
import { act, type ButtonHTMLAttributes, type ComponentProps, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type {
  ComposerPromptEditorHandle,
  ComposerPromptEditorProps,
} from "../ComposerPromptEditor";

let editorProps: ComposerPromptEditorProps;
vi.mock("../ComposerPromptEditor", () => ({
  ComposerPromptEditor: (props: ComposerPromptEditorProps) => {
    editorProps = props;
    props.editorRef.current = editorRef.current;
    return <textarea value={props.value} />;
  },
}));
vi.mock("../ui/command", () => ({
  Command: ({ children }: { children: ReactNode }) => children,
  CommandGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CommandList: (props: ComponentProps<"div">) => <div role="listbox" {...props} />,
  CommandItem: ({
    active,
    value: _value,
    render,
    ...props
  }: ComponentProps<"div"> & {
    active: boolean;
    value: string;
    render: ComponentProps<typeof import("../ui/command").CommandItem>["render"];
  }) =>
    typeof render === "function" ? (
      render({ ...props, role: "option" }, { disabled: false, highlighted: active })
    ) : (
      <div role="option" {...props} />
    ),
}));
vi.mock("../chat/PierreEntryIcon", () => ({ PierreEntryIcon: () => null }));
vi.mock("../ui/button", () => ({
  Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("../../lib/composerPathSearchState", () => ({
  useComposerPathSearch: () => ({
    entries: [{ path: "src/main.ts", kind: "file" }],
    isPending: false,
    error: null,
  }),
}));
vi.mock("../../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));

import { AgentComposerEditor } from "./AgentComposerEditor";
import { AgentUnsentQueue } from "./AgentUnsentQueue";
import { collapseExpandedComposerCursor } from "../../composer-logic";

const onChange = vi.fn<ComposerPromptEditorProps["onChange"]>();
const onCommandKeyDown = vi.fn<NonNullable<ComposerPromptEditorProps["onCommandKeyDown"]>>();
const focusAt = vi.fn();
let snapshot: ReturnType<ComposerPromptEditorHandle["readSnapshot"]>;
const editorRef: { current: ComposerPromptEditorHandle } = {
  current: {
    focus: () => {},
    focusAt,
    focusAtEnd: () => {},
    readSelectionRange: () => ({ start: 4, end: 4 }),
    requestCitationComment: () => {},
    readSnapshot: () => snapshot,
    isCaretOnVisualEdge: () => true,
  },
};
let renderer: ReactTestRenderer | undefined;

function typeText(value: string, contextIds: string[] = []) {
  const cursor = collapseExpandedComposerCursor(value, value.length);
  snapshot = { value, cursor, expandedCursor: value.length, contextIds };
  act(() => editorProps.onChange(value, cursor, value.length, false, contextIds));
}

function openSuggestions(value = "@src", skills: ServerProviderSkill[] = []) {
  act(() => {
    renderer = create(
      <AgentComposerEditor
        environmentId={EnvironmentId.make("environment")}
        cwd="/workspace"
        value={value}
        contextRecords={new Map()}
        editorRef={editorRef}
        skills={skills}
        disabled={false}
        placeholder="Message"
        onChange={onChange}
        onCommandKeyDown={onCommandKeyDown}
        onPaste={() => {}}
      />,
    );
  });
  typeText(value);
  onChange.mockClear();
}

function press(
  key: "Tab" | "Enter" | "ArrowDown" | "Escape",
  modifiers: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean } = {},
) {
  const preventDefault = vi.fn();
  const event = {
    key,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    isComposing: false,
    keyCode: 0,
    preventDefault,
    ...modifiers,
  } as unknown as KeyboardEvent;
  let handled: boolean | undefined;
  act(() => {
    handled = editorProps.onCommandKeyDown?.(key, event);
  });
  return { handled, preventDefault };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.clearAllMocks();
  onCommandKeyDown.mockReturnValue(false);
});

const sourceOne = "b3fdcd90-cb8c-40c2-aee5-c1aba30a9b64";
const sourceTwo = "4fa3e1a2-5b6c-47d8-9012-3456789abcde";
const nativeSkills: ServerProviderSkill[] = [
  {
    name: "review",
    displayName: "review (First repository)",
    path: `meerkat-skill://${sourceOne}/review`,
    enabled: true,
  },
  {
    name: "review",
    displayName: "review (Second repository)",
    path: `meerkat-skill://${sourceTwo}/review`,
    enabled: true,
  },
];

describe("native composer skill selection", () => {
  it.each(["日本語: $review", "/review"])(
    "selects the exact second source from %s without expanding its body",
    (text) => {
      openSuggestions(text, nativeSkills);
      expect(
        renderer!.root
          .findAllByProps({ role: "option" })
          .map((node) => node.props["data-composer-item-id"]),
      ).toEqual(nativeSkills.map((skill) => `skill:${skill.path}`));
      const initialSuggestion = editorProps.suggestionList!;
      const list = renderer!.root.findByProps({ role: "listbox" });
      expect(list.props.id).toBe(initialSuggestion.id);
      expect(
        list.findByProps({ id: initialSuggestion.activeOptionId }).props["data-composer-item-id"],
      ).toBe(`skill:${nativeSkills[0]!.path}`);
      press("ArrowDown");
      const activeOption = list.findByProps({ id: editorProps.suggestionList!.activeOptionId });
      expect(activeOption.props["data-composer-item-id"]).toBe(`skill:${nativeSkills[1]!.path}`);
      expect(activeOption.props["aria-selected"]).toBe(true);
      press("Enter");

      const selected = onChange.mock.calls[0]![0];
      expect(selected).toBe(
        text.replace(/(?:\$|\/)review$/u, `[review](meerkat-skill://${sourceTwo}/review) `),
      );
      expect(extractMeerkatConsoleSkillSelections(selected, "queue")).toEqual({
        text: selected,
        skillReferences: [{ source_uuid: sourceTwo, skill_name: "review" }],
      });
      expect(() => extractMeerkatConsoleSkillSelections(selected, "steer")).toThrow(
        "Skills start with a new turn",
      );
      expect(renderer!.root.findAllByProps({ role: "listbox" })).toHaveLength(0);
      expect(editorProps.suggestionList).toBeUndefined();
    },
  );

  it("omits disabled and agent-only catalog entries without claiming the route is unsupported", () => {
    openSuggestions("$review", [
      { ...nativeSkills[0]!, enabled: false },
      { ...nativeSkills[1]!, userInvocable: false },
    ]);
    expect(renderer!.root.findByType("p").children).toEqual([
      "No matching skills available for this workspace.",
    ]);
    expect(press("Tab").handled).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("reports an empty workspace catalog without claiming a live agent has a skill engine", () => {
    openSuggestions("$review");
    expect(renderer!.root.findByType("p").children).toEqual([
      "No matching skills available for this workspace.",
    ]);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("adds a second source while editing a queued message and saves both original keys", async () => {
    const firstSelection = `[review](meerkat-skill://${sourceOne}/review)`;
    const row: MeerkatAgentQueueItem = {
      id: "queued-message",
      requestId: "queued-request",
      payload: { text: `Use ${firstSelection}` },
      status: "queued",
      error: null,
      receipt: null,
      createdAt: "2026-10-01T10:00:00.000Z",
      updatedAt: "2026-10-01T10:00:00.000Z",
    };
    const save = vi
      .fn<(item: MeerkatAgentQueueItem, text: string) => Promise<boolean>>()
      .mockResolvedValue(true);
    act(() => {
      renderer = create(
        <AgentUnsentQueue
          queue={{ revision: 1, durableId: "agent", waitingReason: null, items: [row] }}
          environmentId={EnvironmentId.make("environment")}
          cwd="/workspace"
          skills={nativeSkills}
          disabled={false}
          loading={false}
          error={null}
          onRefresh={() => {}}
          onEdit={save}
          onMove={() => {}}
          onCancel={() => {}}
          onRetry={() => {}}
        />,
      );
    });
    act(() => renderer!.root.findByProps({ "aria-label": "Edit queued message" }).props.onClick());
    typeText(`Use ${firstSelection} and $review`);
    press("ArrowDown");
    press("Tab");
    const selected = `Use ${firstSelection} and [review](meerkat-skill://${sourceTwo}/review) `;
    expect(editorProps.value).toBe(selected);
    await act(async () => {
      renderer!.root
        .findAllByType("button")
        .find((node) => node.children.includes("Save"))!
        .props.onClick();
    });
    expect(save).toHaveBeenCalledExactlyOnceWith(row, selected);
    expect(
      extractMeerkatConsoleSkillSelections(save.mock.calls[0]![1], "queue").skillReferences,
    ).toEqual([
      { source_uuid: sourceOne, skill_name: "review" },
      { source_uuid: sourceTwo, skill_name: "review" },
    ]);
    expect(renderer!.root.findAllByType("textarea")).toHaveLength(0);
  });
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("native composer autocomplete keyboard handling", () => {
  it("keeps a dismissed token closed and reopens suggestions for a fresh token", () => {
    openSuggestions();
    const listId = editorProps.suggestionList!.id;
    const result = press("Escape");
    expect(result.handled).toBe(true);
    expect(result.preventDefault).toHaveBeenCalledOnce();
    expect(editorProps.suggestionList).toBeUndefined();
    expect(renderer!.root.findAllByProps({ role: "listbox" })).toHaveLength(0);
    expect(onChange).not.toHaveBeenCalled();
    expect(focusAt).not.toHaveBeenCalled();

    typeText("@src/main");
    expect(editorProps.suggestionList).toBeUndefined();
    typeText("");
    typeText("@src/main");
    expect(editorProps.suggestionList!.id).toBe(listId);
    const option = renderer!.root
      .findByProps({ role: "listbox" })
      .findByProps({ id: editorProps.suggestionList!.activeOptionId });
    expect(option.props["data-composer-item-id"]).toBe("path:src/main.ts");
    onChange.mockClear();
    press("Enter");
    expect(onChange.mock.calls[0]?.[0]).toBe(`${serializeComposerFileLink("src/main.ts")} `);
  });

  it("leaves Shift+Tab to reverse focus traversal without inserting a suggestion", () => {
    openSuggestions();
    const result = press("Tab", { shiftKey: true });
    expect(result.handled).toBe(false);
    expect(result.preventDefault).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(onCommandKeyDown).not.toHaveBeenCalled();
    expect(focusAt).not.toHaveBeenCalled();
  });

  it.each(["Tab", "Enter"] as const)("still accepts a suggestion with %s", (key) => {
    openSuggestions();
    const result = press(key);
    expect(result.handled).toBe(true);
    expect(result.preventDefault).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange.mock.calls[0]?.[0]).toBe(`${serializeComposerFileLink("src/main.ts")} `);
    expect(renderer!.root.findAllByProps({ role: "listbox" })).toHaveLength(0);
    expect(focusAt).toHaveBeenCalledOnce();
  });

  it.each([{ ctrlKey: true }, { metaKey: true }])(
    "does not insert for modified Tab (%o)",
    (modifiers) => {
      openSuggestions();
      const result = press("Tab", modifiers);
      expect(result.handled).toBe(false);
      expect(result.preventDefault).not.toHaveBeenCalled();
      expect(onChange).not.toHaveBeenCalled();
      expect(onCommandKeyDown).toHaveBeenCalledOnce();
    },
  );
});
