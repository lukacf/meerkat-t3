/** Native skill identity, kept intact through composer drafts and queued messages. */
export interface MeerkatSkillKey {
  readonly source_uuid: string;
  readonly skill_name: string;
}

const SKILL_HREF =
  /^meerkat-skill:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([^/?#\s]+)$/iu;
const SKILL_LINK = /\[((?:\\.|[^\]\\]){1,512})\]\((meerkat-skill:\/\/[^)\s]+)\)/gu;

export function parseMeerkatSkillHref(href: string): MeerkatSkillKey | null {
  const match = SKILL_HREF.exec(href);
  if (!match) return null;
  try {
    const name = decodeURIComponent(match[2]!);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)) return null;
    return { source_uuid: match[1]!.toLowerCase(), skill_name: name };
  } catch {
    return null;
  }
}

export function meerkatSkillHref(key: MeerkatSkillKey): string {
  return `meerkat-skill://${key.source_uuid.toLowerCase()}/${encodeURIComponent(key.skill_name).replace(/[!'()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

export function serializeProviderSkillSelection(skill: { name: string; path: string }): string {
  const key = parseMeerkatSkillHref(skill.path);
  if (!key) {
    if (/^meerkat-skill:/iu.test(skill.path))
      throw new Error("This skill selection is invalid. Refresh the skill list.");
    return `$${skill.name}`;
  }
  const label = key.skill_name.replace(/[\\[\]]/gu, "\\$&");
  return `[${label}](${meerkatSkillHref(key)})`;
}

export function collectMeerkatSkillSelections(text: string) {
  return Array.from(text.matchAll(SKILL_LINK)).flatMap((match) => {
    const path = match[2]!;
    const key = parseMeerkatSkillHref(path);
    return key
      ? [{ key, path, source: match[0], start: match.index, end: match.index + match[0].length }]
      : [];
  });
}

/** Links are selection requests, not evidence that the runtime loaded a skill. */
export function extractMeerkatSkillSelections(text: string): {
  text: string;
  skillReferences: MeerkatSkillKey[];
} {
  const selections = collectMeerkatSkillSelections(text);
  const references = new Map<string, MeerkatSkillKey>();
  let result = "";
  let cursor = 0;
  for (const selection of selections) {
    result += text.slice(cursor, selection.start) + `$${selection.key.skill_name}`;
    references.set(meerkatSkillHref(selection.key), selection.key);
    cursor = selection.end;
  }
  result += text.slice(cursor);
  if (/meerkat-skill:\/\//iu.test(result)) {
    throw new Error("This skill selection is invalid. Remove it and choose the skill again.");
  }
  // Keep the original operator text as the durable retry witness. Native
  // admission owns resolution; an accepted retry must not read changed files.
  return { text, skillReferences: [...references.values()] };
}

/** Native admission resolves the exact keys when a new console turn starts. */
export function extractMeerkatConsoleSkillSelections(
  text: string,
  handlingMode: "queue" | "steer",
) {
  const selection = extractMeerkatSkillSelections(text);
  if (handlingMode === "steer" && selection.skillReferences.length)
    throw new Error(
      "Skills start with a new turn. Send this as a new message or queue it for later.",
    );
  return selection;
}
