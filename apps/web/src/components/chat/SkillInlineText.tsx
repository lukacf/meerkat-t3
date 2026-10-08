import { Children, cloneElement, isValidElement, type ReactNode } from "react";
import type { ServerProviderSkill } from "@t3tools/contracts";
import {
  formatProviderSkillDisplayName,
  resolveProviderSkillReference,
} from "@t3tools/client-runtime/providerSkills";
import {
  collectMeerkatSkillSelections,
  parseMeerkatSkillHref,
  serializeProviderSkillSelection,
} from "@t3tools/shared/meerkatSkills";

import { SKILL_CHIP_ICON_SVG } from "../composerInlineChip";
import { ContextChip, ContextChipLabel } from "../ContextChip";

const SKILL_TOKEN_REGEX =
  /(^|\s)\p{Sc}(?![0-9][0-9_]*(?:[kKmMbBtT]|[eE][0-9]+)?(?:\s|$))(?=[a-zA-Z0-9:_-]*[a-zA-Z])([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s|$)/gu;

type InlineSkill = Pick<ServerProviderSkill, "name" | "displayName"> &
  Partial<Pick<ServerProviderSkill, "path">>;

export function NativeSkillInlineLink({
  href,
  skills,
}: {
  href: string;
  skills: ReadonlyArray<InlineSkill>;
}) {
  const key = parseMeerkatSkillHref(href);
  if (!key) return null;
  const skill = resolveProviderSkillReference(skills, key.skill_name, href) ?? {
    name: key.skill_name,
    displayName: `${key.skill_name} (${key.source_uuid})`,
  };
  return (
    <SkillChip
      skill={skill}
      rawText={serializeProviderSkillSelection({ name: key.skill_name, path: href })}
    />
  );
}

export function SkillInlineText(props: { text: string; skills: ReadonlyArray<InlineSkill> }) {
  const selections = collectMeerkatSkillSelections(props.text);
  if (selections.length) {
    const fragments: ReactNode[] = [];
    let start = 0;
    for (const selection of selections) {
      fragments.push(
        <SkillInlineText
          key={`text:${selection.start}`}
          text={props.text.slice(start, selection.start)}
          skills={props.skills}
        />,
        <NativeSkillInlineLink
          key={`skill:${selection.start}`}
          href={selection.path}
          skills={props.skills}
        />,
      );
      start = selection.end;
    }
    fragments.push(
      <SkillInlineText key="tail" text={props.text.slice(start)} skills={props.skills} />,
    );
    return <>{fragments}</>;
  }
  const nodes: ReactNode[] = [];
  let cursor = 0;

  for (const match of props.text.matchAll(SKILL_TOKEN_REGEX)) {
    const prefix = match[1] ?? "";
    const name = match[2] ?? "";
    const start = (match.index ?? 0) + prefix.length;
    const rawText = `$${name}`;
    const skill = resolveProviderSkillReference(props.skills, name);
    if (!skill) {
      continue;
    }

    if (start > cursor) {
      nodes.push(props.text.slice(cursor, start));
    }
    nodes.push(<SkillChip key={`${start}:${name}`} skill={skill} rawText={rawText} />);
    cursor = (match.index ?? 0) + match[0].length;
  }

  if (cursor === 0) {
    return <>{props.text}</>;
  }
  if (cursor < props.text.length) {
    nodes.push(props.text.slice(cursor));
  }
  return <>{nodes}</>;
}

export function renderSkillInlineMarkdownChildren(
  children: ReactNode,
  skills: ReadonlyArray<InlineSkill>,
): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === "string") {
      return <SkillInlineText text={child} skills={skills} />;
    }
    if (!isValidElement<{ children?: ReactNode; node?: { tagName?: string } }>(child)) {
      return child;
    }
    // Custom react-markdown components replace the intrinsic type, so also
    // check the hast node they carry.
    const markdownTagName = typeof child.type === "string" ? child.type : child.props.node?.tagName;
    if (markdownTagName === "code" || markdownTagName === "a") {
      return child;
    }
    if (!("children" in child.props)) {
      return child;
    }
    return cloneElement(
      child,
      undefined,
      renderSkillInlineMarkdownChildren(child.props.children, skills),
    );
  });
}

function SkillChip(props: { skill: InlineSkill; rawText: string }) {
  return (
    <ContextChip kind="skill" data-markdown-copy={props.rawText}>
      <SkillChipIcon />
      <ContextChipLabel>{formatProviderSkillDisplayName(props.skill)}</ContextChipLabel>
    </ContextChip>
  );
}

/** The skill glyph; the surrounding chip sizes its svg. */
export function SkillChipIcon() {
  return (
    <span
      aria-hidden="true"
      className="contents"
      dangerouslySetInnerHTML={{ __html: SKILL_CHIP_ICON_SVG }}
    />
  );
}
