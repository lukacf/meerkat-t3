import { useId, useMemo, useRef, useState } from "react";
import {
  ProviderDriverKind,
  type EnvironmentId,
  type ServerProviderSkill,
} from "@t3tools/contracts";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";
import { serializeProviderSkillSelection } from "@t3tools/shared/meerkatSkills";
import { formatProviderSkillDisplayName } from "@t3tools/client-runtime/providerSkills";
import {
  collapseExpandedComposerCursor,
  detectComposerTrigger,
  replaceTextRange,
} from "../../composer-logic";
import { useComposerPathSearch } from "../../lib/composerPathSearchState";
import { searchProviderSkills } from "../../providerSkillSearch";
import { useTheme } from "../../hooks/useTheme";
import { ComposerPromptEditor, type ComposerPromptEditorProps } from "../ComposerPromptEditor";
import {
  ComposerCommandMenu,
  composerCommandOptionId,
  type ComposerCommandItem,
} from "../chat/ComposerCommandMenu";
import { useComposerTriggerState } from "../chat/useComposerTriggerState";

/** The donor editor, path lookup, skill catalogue and keyboard menu in a native conversation. */
export function AgentComposerEditor({
  environmentId,
  cwd,
  ...props
}: Omit<ComposerPromptEditorProps, "cursor"> & {
  environmentId: EnvironmentId;
  cwd: string | undefined;
  skills: ReadonlyArray<ServerProviderSkill>;
}) {
  const { resolvedTheme } = useTheme();
  const suggestionListId = useId();
  const [cursor, setCursor] = useState(() =>
    collapseExpandedComposerCursor(props.value, props.value.length),
  );
  const { trigger, setTrigger, dismissTrigger, resetTrigger } = useComposerTriggerState(() => null);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const selectLocked = useRef(false);
  const entries = useComposerPathSearch({
    environmentId,
    cwd: trigger?.kind === "path" ? (cwd ?? null) : null,
    query: trigger?.kind === "path" ? trigger.query : null,
  });
  const items = useMemo<ComposerCommandItem[]>(() => {
    if (trigger?.kind === "path")
      return entries.entries.map((entry) => ({
        id: `path:${entry.path}`,
        type: "path",
        path: entry.path,
        pathKind: entry.kind,
        label: entry.path,
        description: entry.kind === "directory" ? "Folder" : "File",
      }));
    if (trigger?.kind === "skill" || trigger?.kind === "slash-command")
      return searchProviderSkills(props.skills, trigger.query, 40).map((skill) => ({
        id: `skill:${skill.path}`,
        type: "skill",
        provider: ProviderDriverKind.make("meerkat"),
        skill,
        label: formatProviderSkillDisplayName(skill),
        description: skill.shortDescription ?? skill.description ?? "Workspace skill",
      }));
    return [];
  }, [entries.entries, props.skills, trigger]);
  const active = items.find((item) => item.id === highlighted) ?? items[0];
  const menuOpen = trigger !== null && trigger.kind !== "pull-request";
  function select(item: ComposerCommandItem) {
    if (selectLocked.current || props.disabled) return;
    const snapshot = props.editorRef.current?.readSnapshot();
    const current = snapshot && detectComposerTrigger(snapshot.value, snapshot.expandedCursor);
    if (!snapshot || !current || (item.type !== "path" && item.type !== "skill")) return;
    const replacement =
      item.type === "path"
        ? `${serializeComposerFileLink(item.path)} `
        : `${serializeProviderSkillSelection(item.skill)} `;
    const next = replaceTextRange(
      snapshot.value,
      current.rangeStart,
      current.rangeEnd,
      replacement,
    );
    const nextCursor = collapseExpandedComposerCursor(next.text, next.cursor);
    props.onChange(next.text, nextCursor, next.cursor, false, snapshot.contextIds);
    setCursor(nextCursor);
    resetTrigger(null);
    setHighlighted(null);
    selectLocked.current = true;
    requestAnimationFrame(() => {
      selectLocked.current = false;
      props.editorRef.current?.focusAt(nextCursor);
    });
  }
  return (
    <div className="relative min-w-0">
      {menuOpen && !props.disabled ? (
        <div className="mb-2 max-h-48 overflow-y-auto rounded-xl border border-border bg-popover">
          <ComposerCommandMenu
            listId={suggestionListId}
            items={items}
            resolvedTheme={resolvedTheme}
            isLoading={trigger.kind === "path" && entries.isPending}
            triggerKind={trigger.kind}
            emptyStateText={
              trigger.kind === "path"
                ? (entries.error ?? "No matching files or folders.")
                : "No matching skills available for this workspace."
            }
            activeItemId={active?.id ?? null}
            onHighlightedItemChange={setHighlighted}
            onSelect={select}
          />
        </div>
      ) : null}
      <ComposerPromptEditor
        {...props}
        suggestionList={
          menuOpen && !props.disabled && active
            ? {
                id: suggestionListId,
                activeOptionId: composerCommandOptionId(suggestionListId, active.id),
              }
            : undefined
        }
        cursor={cursor}
        onChange={(text, nextCursor, expandedCursor, adjacent, contextIds) => {
          props.onChange(text, nextCursor, expandedCursor, adjacent, contextIds);
          setCursor(nextCursor);
          setTrigger(detectComposerTrigger(text, expandedCursor));
          setHighlighted(null);
        }}
        onCommandKeyDown={(key, event, isTaskItem) => {
          if (key === "Tab" && event.shiftKey) return false;
          if (menuOpen && !event.isComposing && event.keyCode !== 229) {
            if (key === "Escape") {
              event.preventDefault();
              dismissTrigger(trigger);
              return true;
            }
            if (items.length && (key === "ArrowDown" || key === "ArrowUp")) {
              event.preventDefault();
              const index = Math.max(
                0,
                items.findIndex((item) => item.id === active?.id),
              );
              setHighlighted(
                items[(index + (key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.id ??
                  null,
              );
              return true;
            }
            if (active && (key === "Enter" || key === "Tab") && !event.metaKey && !event.ctrlKey) {
              event.preventDefault();
              select(active);
              return true;
            }
          }
          return props.onCommandKeyDown?.(key, event, isTaskItem) ?? false;
        }}
      />
    </div>
  );
}
