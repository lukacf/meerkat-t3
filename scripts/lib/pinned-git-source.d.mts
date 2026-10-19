export interface PinnedGitSource {
  repository: string;
  commit: string;
}

export function pinnedGitSource(source: string): PinnedGitSource;
export function readPinnedGitPackage(
  source: string,
  directory: string,
): PinnedGitSource & {
  manifest: Buffer;
  notices: Array<{ path: string; resolvedPath: string; data: Buffer }>;
};
