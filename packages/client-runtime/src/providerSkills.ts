import type {
  ServerProvider,
  ServerProviderSkill,
  ServerProviderSlashCommand,
} from "@t3tools/contracts";
import { meerkatSkillHref, parseMeerkatSkillHref } from "@t3tools/shared/meerkatSkills";

export type ProviderSkillSourceKind = "app" | "repo" | "project" | "personal" | "system" | "other";

function titleCaseWords(value: string): string {
  const words: string[] = [];
  for (const segment of value.split(/[\s:_-]+/)) {
    if (segment.length === 0) continue;
    words.push(segment.charAt(0).toUpperCase() + segment.slice(1));
  }
  return words.join(" ");
}

function normalizePathSeparators(pathValue: string): string {
  return pathValue.replaceAll("\\", "/");
}

export function formatProviderSkillDisplayName(
  skill: Pick<ServerProviderSkill, "name" | "displayName">,
): string {
  const displayName = skill.displayName?.trim();
  if (displayName) {
    return displayName;
  }
  return titleCaseWords(skill.name);
}

type SkillReferenceCandidate = Pick<ServerProviderSkill, "name" | "displayName"> &
  Partial<Pick<ServerProviderSkill, "path" | "description" | "shortDescription">>;

/** Native source identity must come from a selection link, never a bare name. */
export function resolveProviderSkillReference<T extends SkillReferenceCandidate>(
  skills: ReadonlyArray<T>,
  name: string,
  path?: string,
): T | undefined {
  const nativeKey = path ? parseMeerkatSkillHref(path) : null;
  return skills.find((candidate) => {
    if (nativeKey) {
      const candidateKey = candidate.path ? parseMeerkatSkillHref(candidate.path) : null;
      return (
        candidateKey !== null && meerkatSkillHref(candidateKey) === meerkatSkillHref(nativeKey)
      );
    }
    if (path) return candidate.path === path;
    return candidate.name === name && !/^meerkat-skill:/iu.test(candidate.path ?? "");
  });
}

export function providerSkillReferenceMeta(
  skills: ReadonlyArray<SkillReferenceCandidate>,
  name: string,
  path?: string,
): { label: string; description: string | null } {
  const skill = resolveProviderSkillReference(skills, name, path);
  if (skill)
    return {
      label: formatProviderSkillDisplayName(skill),
      description: skill.shortDescription?.trim() || skill.description?.trim() || null,
    };
  const nativeKey = path ? parseMeerkatSkillHref(path) : null;
  if (nativeKey)
    return {
      label: `${nativeKey.skill_name} (${nativeKey.source_uuid.slice(0, 8)})`,
      description: null,
    };
  if (
    !path &&
    skills.some(
      (candidate) => candidate.name === name && /^meerkat-skill:/iu.test(candidate.path ?? ""),
    )
  )
    return {
      label: `${formatProviderSkillDisplayName({ name })} (unselected)`,
      description:
        "This text does not select a native skill. Choose a source from the conversation skill menu.",
    };
  return { label: formatProviderSkillDisplayName({ name }), description: null };
}

export function dedupeProviderSkillsByName(
  skills: ReadonlyArray<ServerProviderSkill>,
): ServerProviderSkill[] {
  const seenNames = new Set<string>();
  return skills.filter((skill) => {
    const key = parseMeerkatSkillHref(skill.path);
    const normalizedName = key ? meerkatSkillHref(key) : skill.name.trim().toLowerCase();
    if (seenNames.has(normalizedName)) {
      return false;
    }
    seenNames.add(normalizedName);
    return true;
  });
}

/**
 * Whether a composer pick can start this skill. A skill switched off in the
 * provider's settings will not run, and one the provider reserves for the
 * agent (Claude Code's `user-invocable: false`) rejects a user invocation.
 * Everything else, including skills the agent may not start on its own, is
 * fair game: the server dispatches the pick in the provider's native form.
 */
export function isProviderSkillUserInvocable(
  skill: Pick<ServerProviderSkill, "enabled" | "userInvocable">,
): boolean {
  return skill.enabled && skill.userInvocable !== false;
}

export function getProviderSkillsForSlashMenu(
  skills: ReadonlyArray<ServerProviderSkill>,
  showSkillsInSlashMenu: boolean,
): ServerProviderSkill[] {
  return showSkillsInSlashMenu
    ? dedupeProviderSkillsByName(skills.filter(isProviderSkillUserInvocable))
    : [];
}

export function getProviderSlashCommandsForSlashMenu(
  slashCommands: ReadonlyArray<ServerProviderSlashCommand>,
  visibleSkills: ReadonlyArray<ServerProviderSkill>,
): ServerProviderSlashCommand[] {
  const skillNames = new Set(visibleSkills.map((skill) => skill.name.trim().toLowerCase()));
  return slashCommands.filter((command) => !skillNames.has(command.name.trim().toLowerCase()));
}

export function resolveProviderSkillSourceKind(
  skill: Pick<ServerProviderSkill, "path" | "scope">,
): ProviderSkillSourceKind {
  const normalizedPath = normalizePathSeparators(skill.path);
  if (normalizedPath.includes("/.codex/plugins/") || normalizedPath.includes("/.agents/plugins/")) {
    return "app";
  }

  const normalizedScope = skill.scope?.trim().toLowerCase();
  switch (normalizedScope) {
    case "repo":
    case "repository":
      return "repo";
    case "project":
    case "workspace":
    case "local":
      return "project";
    case "user":
    case "personal":
      return "personal";
    case "system":
      return "system";
    case undefined:
    case "":
      return "other";
    default:
      return "other";
  }
}

function resolveProviderWorkspaceSnapshot(
  provider: ServerProvider,
  cwd: string | null | undefined,
) {
  if (!cwd) return undefined;
  return provider.workspaceSnapshots?.find((snapshot) => snapshot.cwd === cwd);
}

export function resolveProviderSkillsForCwd(
  provider: ServerProvider,
  cwd: string | null | undefined,
): ServerProvider["skills"] {
  return resolveProviderWorkspaceSnapshot(provider, cwd)?.skills ?? provider.skills;
}

export function resolveProviderSlashCommandsForCwd(
  provider: ServerProvider,
  cwd: string | null | undefined,
): ServerProvider["slashCommands"] {
  return resolveProviderWorkspaceSnapshot(provider, cwd)?.slashCommands ?? provider.slashCommands;
}
