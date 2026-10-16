/** A fork release destination must be explicitly supplied, canonical, and not the donor. */
export function resolveMeerkatReleaseRepository(value: string | null | undefined): {
  owner: string;
  repo: string;
} | null {
  const match = value
    ?.trim()
    .match(/^([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9_][A-Za-z0-9_.-]{0,99})$/);
  if (!match) return null;
  const owner = match[1]!;
  const repo = match[2]!;
  if (repo.toLowerCase().endsWith(".git")) return null;
  if (owner.toLowerCase() === "pingdotgg" && repo.toLowerCase() === "t3code") return null;
  return { owner, repo };
}
