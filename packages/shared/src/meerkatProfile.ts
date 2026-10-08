// @effect-diagnostics nodeBuiltinImport:off - first-run configuration is a Node filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Reuse the profile in place. Runtime upgrades never relocate native sessions or their media. */
export function configureMeerkatProfile(
  value: unknown,
  input: { projectPath?: string; desktop: boolean },
) {
  if (!record(value))
    throw new Error(
      "Meerkat profile settings must be a JSON object. Repair settings.json before launching.",
    );
  const instances = record(value.providerInstances) ? value.providerInstances : {};
  const current = record(instances.meerkat) ? instances.meerkat : {};
  if (current.driver && current.driver !== "meerkat")
    throw new Error("The meerkat provider slot belongs to another driver. Choose another profile.");
  const config = record(current.config) ? current.config : {};
  return {
    ...value,
    providerInstances: {
      ...Object.fromEntries(
        ["codex", "claudeAgent", "cursor", "grok", "opencode", "antigravity"].map((driver) => [
          driver,
          { driver, enabled: false },
        ]),
      ),
      ...instances,
      meerkat: {
        driver: "meerkat",
        displayName: "Meerkat MobKit",
        enabled: true,
        ...current,
        config: {
          workspacePolicy: "selected-model-only",
          ...config,
          gatewayBinaryPath: "meerkat-desktop-stdio",
          ...(input.projectPath ? { projectPath: input.projectPath } : {}),
        },
      },
    },
    enableAgentBrowserAccess: value.enableAgentBrowserAccess ?? input.desktop,
    enableAgentDeviceAccess: value.enableAgentDeviceAccess ?? false,
    defaultRuntimeMode: value.defaultRuntimeMode ?? "full-access",
  };
}

export async function initializeMeerkatProfile(
  home: string,
  input: { projectPath?: string; desktop: boolean; onlyIfMissing?: boolean },
) {
  const file = NodePath.join(home, "userdata", "settings.json");
  let settings: unknown = {};
  try {
    settings = JSON.parse(await NodeFSP.readFile(file, "utf8"));
    if (input.onlyIfMissing) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const next = configureMeerkatProfile(settings, input);
  await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.meerkat-${process.pid}.tmp`;
  try {
    await NodeFSP.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await NodeFSP.rename(temporary, file);
  } finally {
    await NodeFSP.rm(temporary, { force: true });
  }
}
