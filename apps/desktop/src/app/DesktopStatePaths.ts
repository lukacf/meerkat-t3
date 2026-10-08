import * as Option from "effect/Option";

export type JoinPath = (first: string, ...segments: string[]) => string;

export function resolveDesktopAppDataDirectory(input: {
  readonly platform: NodeJS.Platform;
  readonly homeDirectory: string;
  readonly appDataDirectory: Option.Option<string>;
  readonly xdgConfigHome: Option.Option<string>;
  readonly joinPath: JoinPath;
}): string {
  return input.platform === "win32"
    ? Option.getOrElse(input.appDataDirectory, () =>
        input.joinPath(input.homeDirectory, "AppData", "Roaming"),
      )
    : input.platform === "darwin"
      ? input.joinPath(input.homeDirectory, "Library", "Application Support")
      : Option.getOrElse(input.xdgConfigHome, () =>
          input.joinPath(input.homeDirectory, ".config"),
        );
}

export function resolveDesktopUserDataDirectoryName(isDevelopment: boolean): string {
  return isDevelopment ? "meerkat-t3-dev" : "meerkat-t3";
}

function normalizeConfiguredBaseDir(t3Home: Option.Option<string>): Option.Option<string> {
  if (Option.isNone(t3Home)) {
    return Option.none();
  }
  const trimmed = t3Home.value.trim();
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
}

export function resolveDesktopBaseDir(input: {
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
  readonly t3Home: Option.Option<string>;
}): string {
  return Option.getOrElse(normalizeConfiguredBaseDir(input.t3Home), () =>
    input.joinPath(input.homeDirectory, ".meerkat-t3"),
  );
}

export function resolveDesktopStateDir(input: {
  readonly baseDir: string;
  readonly isDevelopment: boolean;
  readonly joinPath: JoinPath;
  readonly t3Home: Option.Option<string>;
}): string {
  const useDevSubdir =
    input.isDevelopment && Option.isNone(normalizeConfiguredBaseDir(input.t3Home));
  return input.joinPath(input.baseDir, useDevSubdir ? "dev" : "userdata");
}
