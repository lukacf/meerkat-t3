import type { SourceControlDiscoveryResult } from "@t3tools/contracts";
import * as Option from "effect/Option";

const sources = ["url", "github", "gitlab", "forgejo", "bitbucket", "azure-devops"] as const;
export type CloneSourceReadiness = Record<
  (typeof sources)[number],
  { readonly ready: boolean; readonly hint: string | null }
>;

export function gitCloneSetupHint(discovery: SourceControlDiscoveryResult | null): string | null {
  const git = discovery?.versionControlSystems.find((item) => item.kind === "git");
  return git?.status === "missing"
    ? `Git is not installed on the selected server. ${git.installHint} Then rescan in Settings -> Source Control.`
    : null;
}

export function buildAddProjectRemoteSourceReadiness(
  discovery: SourceControlDiscoveryResult | null,
): CloneSourceReadiness {
  const gitHint = gitCloneSetupHint(discovery);
  const providers = new Map(discovery?.sourceControlProviders.map((item) => [item.kind, item]));
  const result = {} as CloneSourceReadiness;
  for (const source of sources) {
    if (gitHint) {
      result[source] = { ready: false, hint: gitHint };
      continue;
    }
    if (source === "url") {
      result[source] = { ready: true, hint: null };
      continue;
    }
    const provider = providers.get(source);
    result[source] = !provider
      ? {
          ready: false,
          hint: "Provider status unavailable. Open Settings -> Source Control and rescan.",
        }
      : provider.status !== "available"
        ? { ready: false, hint: provider.installHint }
        : provider.auth.status === "unauthenticated"
          ? {
              ready: false,
              hint:
                Option.getOrNull(provider.auth.detail) ??
                `${provider.label} is not authenticated. Open Settings -> Source Control for setup guidance.`,
            }
          : { ready: true, hint: null };
  }
  return result;
}
