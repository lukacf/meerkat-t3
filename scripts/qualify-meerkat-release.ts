#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalDate:off - This standalone release CLI records wall-clock receipts while serializing existing process-owning fixtures.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { verifyMeerkatRuntime } from "@t3tools/shared/meerkatRuntime";

const repoRoot = NodeURL.fileURLToPath(new URL("../", import.meta.url));
const usage =
  "Usage: pnpm release:qualify --server-entry ABS --runtime-dir ABS --evidence-dir NEW_ABS [--current-app ABS --previous-app ABS] [--plan]";

export interface QualificationOptions {
  serverEntry: string;
  runtimeDirectory: string;
  evidenceDirectory: string;
  currentApp?: string;
  previousApp?: string;
  planOnly: boolean;
}

export function parseQualificationOptions(args: readonly string[]): QualificationOptions {
  const names = new Map([
    ["--server-entry", "serverEntry"],
    ["--runtime-dir", "runtimeDirectory"],
    ["--evidence-dir", "evidenceDirectory"],
    ["--current-app", "currentApp"],
    ["--previous-app", "previousApp"],
  ]);
  const values: Record<string, string> = {};
  let planOnly = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--plan" && !planOnly) {
      planOnly = true;
      continue;
    }
    const key = names.get(argument);
    const value = args[++index];
    if (
      !key ||
      values[key] ||
      !value ||
      !NodePath.isAbsolute(value) ||
      value.trim() !== value ||
      /[\r\n\0]/.test(value)
    )
      throw new Error(usage);
    values[key] = value;
  }
  if (!values.serverEntry || !values.runtimeDirectory || !values.evidenceDirectory)
    throw new Error(usage);
  if (Boolean(values.currentApp) !== Boolean(values.previousApp))
    throw new Error(
      "Packaged acceptance requires both --current-app and --previous-app; an upgrade must not silently become a same-version test.",
    );
  return {
    serverEntry: values.serverEntry,
    runtimeDirectory: values.runtimeDirectory,
    evidenceDirectory: values.evidenceDirectory,
    ...(values.currentApp
      ? { currentApp: values.currentApp, previousApp: values.previousApp! }
      : {}),
    planOnly,
  };
}

export interface QualificationSuite {
  id: string;
  file: string;
  receipt?: string;
  receiptSurfaces?: readonly string[];
  tls?: boolean;
  nodeTest?: boolean;
}

export function qualificationSuites(packaged: boolean): QualificationSuite[] {
  return [
    {
      id: "local-workflow",
      file: "src/provider/meerkat/MeerkatWorkflow.server.native.test.ts",
      receipt: "evidence/workflow-acceptance.json",
    },
    {
      id: "local-steering",
      file: "src/provider/meerkat/MeerkatSteering.server.native.test.ts",
      receipt: "evidence/steering-acceptance.json",
      receiptSurfaces: ["thread", "project-agent", "owned-child"],
    },
    {
      id: "local-queue-reconnect",
      file: "src/provider/meerkat/MeerkatQueueReconnect.server.native.test.ts",
      receipt: "evidence/queue-reconnect-acceptance.json",
    },
    {
      id: "local-specialist-revision",
      file: "src/provider/meerkat/MeerkatSpecialistRevision.server.native.test.ts",
      receipt: "evidence/specialist-revision-acceptance.json",
    },
    {
      id: "shared-specialists",
      file: "src/shared/SharedSpecialist.server.native.test.ts",
      receipt: "evidence/shared-specialist-acceptance.json",
    },
    {
      id: "shared-expansion",
      file: "src/shared/SharedExpansion.server.native.test.ts",
      receipt: "evidence/shared-expansion-acceptance.json",
    },
    {
      id: "shared-tls",
      file: "src/shared/SharedExpansion.server.native.test.ts",
      receipt: "evidence/shared-expansion-acceptance.json",
      tls: true,
    },
    {
      id: "shared-composition",
      file: "src/shared/SharedComposition.server.native.test.ts",
      receipt: "evidence/shared-composition-acceptance.json",
    },
    {
      id: "offline-recovery-contracts",
      file: "scripts/meerkat-profile-backup.test.mjs",
      nodeTest: true,
    },
    ...(packaged
      ? [
          {
            id: "packaged-upgrade",
            file: "src/provider/meerkat/MeerkatProfileUpgrade.server.native.test.ts",
            receipt: "upgrade-evidence.json",
          },
          {
            id: "packaged-checkpoints",
            file: "src/provider/meerkat/MeerkatCheckpoints.server.native.test.ts",
            receipt: "evidence/checkpoint-acceptance.json",
          },
          {
            id: "packaged-no-host",
            file: "src/provider/meerkat/MeerkatPreviewNoHost.server.native.test.ts",
            receipt: "evidence/nohost-acceptance.json",
          },
        ]
      : []),
  ];
}

export function qualificationEnvironment(
  options: QualificationOptions,
  root: string,
  suite: QualificationSuite,
  executable: string,
): NodeJS.ProcessEnv {
  // An allowlist also excludes NODE_OPTIONS, proxy settings, provider keys and native/profile overrides.
  return {
    PATH: [NodePath.dirname(executable), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(
      NodePath.delimiter,
    ),
    HOME: NodePath.join(root, "home"),
    USERPROFILE: NodePath.join(root, "home"),
    XDG_CONFIG_HOME: NodePath.join(root, "config"),
    XDG_CACHE_HOME: NodePath.join(root, "cache"),
    XDG_DATA_HOME: NodePath.join(root, "data"),
    TMPDIR: NodePath.join(root, "tmp"),
    TMP: NodePath.join(root, "tmp"),
    TEMP: NodePath.join(root, "tmp"),
    LANG: "en_US.UTF-8",
    CI: "true",
    NO_COLOR: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    T3CODE_TELEMETRY_ENABLED: "false",
    T3CODE_OTEL_SDK_DISABLED: "true",
    T3CODE_TEST_MEERKAT_SERVER_ENTRY: options.serverEntry,
    T3CODE_TEST_MEERKAT_RUNTIME_DIR: options.runtimeDirectory,
    ...(suite.tls ? { T3CODE_TEST_SHARED_TLS: "1" } : {}),
    ...(options.currentApp
      ? {
          T3CODE_TEST_MEERKAT_UPGRADE_CURRENT_APP: options.currentApp,
          T3CODE_TEST_MEERKAT_UPGRADE_PREVIOUS_APP: options.previousApp,
          T3CODE_TEST_MEERKAT_CHECKPOINT_APP: options.currentApp,
          T3CODE_TEST_MEERKAT_NOHOST_APP: options.currentApp,
        }
      : {}),
  };
}

export function assertVitestPassed(report: unknown): void {
  const value = report as {
    success?: boolean;
    numTotalTests?: number;
    numPassedTests?: number;
    numFailedTests?: number;
    numPendingTests?: number;
    numTodoTests?: number;
    testResults?: { assertionResults?: { status?: string }[] }[];
  };
  const assertions = value.testResults?.flatMap((result) => result.assertionResults ?? []) ?? [];
  if (
    value.success !== true ||
    !value.numTotalTests ||
    value.numPassedTests !== value.numTotalTests ||
    value.numFailedTests !== 0 ||
    value.numPendingTests !== 0 ||
    (value.numTodoTests ?? 0) !== 0 ||
    assertions.length !== value.numTotalTests ||
    assertions.some((assertion) => assertion.status !== "passed")
  )
    throw new Error(
      "Acceptance did not run and pass every test; skipped, missing and failed tests cannot qualify a release.",
    );
}

export function assertNodeTestsPassed(output: string): void {
  const count = (name: string) =>
    Number(output.match(new RegExp(`^# ${name} (\\d+)$`, "m"))?.[1] ?? "NaN");
  if (
    !(count("tests") > 0) ||
    count("pass") !== count("tests") ||
    count("fail") !== 0 ||
    count("cancelled") !== 0 ||
    count("skipped") !== 0 ||
    count("todo") !== 0
  )
    throw new Error("Offline recovery tests must all run and pass without skips.");
}

export function assertAcceptanceReceipt(receipt: unknown, upgrade: boolean): void {
  const value = receipt as {
    passed?: boolean;
    pass?: boolean;
    cleanupComplete?: boolean;
    failures?: unknown[];
    providerErrors?: unknown[];
  };
  if (
    upgrade
      ? value.pass !== true || !Array.isArray(value.failures) || value.failures.length !== 0
      : value.passed !== true || value.cleanupComplete !== true
  )
    throw new Error(
      "Acceptance receipt does not establish successful assertions and owned cleanup.",
    );
  if (value.providerErrors && value.providerErrors.length !== 0)
    throw new Error("Acceptance receipt contains provider errors.");
}

async function sha256(path: string): Promise<string> {
  if (!(await NodeFSP.lstat(path)).isFile())
    throw new Error(`Expected a regular input file: ${path}`);
  const hash = NodeCrypto.createHash("sha256");
  for await (const bytes of NodeFS.createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}

async function captureRuntime(directory: string, inputs: Record<string, string>): Promise<string> {
  const manifest = await verifyMeerkatRuntime(directory);
  const manifestPath = NodePath.join(directory, "manifest.json");
  inputs[manifestPath] = await sha256(manifestPath);
  for (const [relative, expected] of Object.entries(manifest.files).sort()) {
    if (
      NodePath.isAbsolute(relative) ||
      relative.split(/[\\/]/).some((part) => part === ".." || part === "") ||
      !/^[a-f0-9]{64}$/.test(expected)
    )
      throw new Error("Invalid native runtime manifest file entry.");
    const path = NodePath.join(directory, relative);
    const actual = await sha256(path);
    if (actual !== expected)
      throw new Error(`Native runtime file does not match its manifest: ${relative}`);
    inputs[path] = actual;
  }
  // Formatting and property order do not change runtime identity. Every declared
  // file and build field must agree between staged and packaged current inputs.
  return JSON.stringify([
    manifest.binary,
    Object.entries(manifest.build).sort(),
    Object.entries(manifest.files).sort(),
  ]);
}

export async function captureQualificationInputs(
  options: QualificationOptions,
): Promise<Record<string, string>> {
  const inputs: Record<string, string> = {
    [options.serverEntry]: await sha256(options.serverEntry),
  };
  // The server entry imports sibling chunks. Bind those executable bytes too.
  const serverDirectory = NodePath.dirname(options.serverEntry);
  for (const name of (await NodeFSP.readdir(serverDirectory)).sort()) {
    if (!name.endsWith(".mjs")) continue;
    const path = NodePath.join(serverDirectory, name);
    inputs[path] = await sha256(path);
  }
  const stagedRuntime = await captureRuntime(options.runtimeDirectory, inputs);
  for (const appPath of [options.currentApp, options.previousApp]) {
    if (!appPath) continue;
    if (!appPath.endsWith(".app"))
      throw new Error("Packaged acceptance requires extracted macOS application bundles.");
    const app = await NodeFSP.realpath(appPath);
    const archive = NodePath.join(app, "Contents/Resources/app.asar");
    inputs[archive] = await sha256(archive);
    const executableDirectory = NodePath.join(app, "Contents/MacOS");
    const executables = await NodeFSP.readdir(executableDirectory);
    if (executables.length !== 1)
      throw new Error("Packaged acceptance requires exactly one application executable.");
    const executable = NodePath.join(executableDirectory, executables[0]!);
    inputs[executable] = await sha256(executable);
    await NodeFSP.access(executable, NodeFS.constants.X_OK);
    const packagedRuntime = await captureRuntime(
      NodePath.join(app, "Contents/Resources/meerkat-runtime"),
      inputs,
    );
    if (appPath === options.currentApp && packagedRuntime !== stagedRuntime)
      throw new Error("Current packaged runtime does not match the staged qualification runtime.");
  }
  return inputs;
}

async function runSuite(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  log: string,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; pid: number | undefined }> {
  const output = await NodeFSP.open(log, "wx", 0o600);
  try {
    return await new Promise((resolve, reject) => {
      const child = NodeChildProcess.spawn(process.execPath, args, {
        cwd,
        env,
        shell: false,
        stdio: ["ignore", output.fd, output.fd],
      });
      const processReceipt = NodePath.join(NodePath.dirname(log), "test-process.json");
      const processRecord = { pid: child.pid, startedAt: new Date().toISOString(), cwd, args };
      let receiptError: unknown;
      try {
        NodeFS.writeFileSync(processReceipt, `${JSON.stringify(processRecord, null, 2)}\n`, {
          flag: "wx",
          mode: 0o600,
        });
      } catch (error) {
        receiptError = error;
      }
      // Fixtures own their native drain budgets. No wrapper timeout or forced kill races that cleanup.
      const interrupt = () => {
        child.kill("SIGINT");
      };
      const terminate = () => {
        child.kill("SIGTERM");
      };
      process.once("SIGINT", interrupt);
      process.once("SIGTERM", terminate);
      const detach = () => {
        process.off("SIGINT", interrupt);
        process.off("SIGTERM", terminate);
      };
      child.once("error", (error) => {
        detach();
        reject(error);
      });
      child.once("exit", (code, signal) => {
        detach();
        try {
          NodeFS.writeFileSync(
            processReceipt,
            `${JSON.stringify({ ...processRecord, code, signal, finishedAt: new Date().toISOString() }, null, 2)}\n`,
            { mode: 0o600 },
          );
        } catch (error) {
          receiptError ??= error;
        }
        // Evidence failure stops the next suite, after this fixture has had time to drain.
        if (receiptError) {
          reject(receiptError);
          return;
        }
        resolve({ code, signal, pid: child.pid });
      });
    });
  } finally {
    await output.close();
  }
}

export async function retainQualificationReceipt(
  tmp: string,
  suite: QualificationSuite,
  directory: string,
): Promise<void> {
  if (!suite.receipt) return;
  const matches: string[] = [];
  for (const entry of await NodeFSP.readdir(tmp, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = NodePath.join(tmp, entry.name, suite.receipt);
    const stat = await NodeFSP.lstat(candidate).catch(() => undefined);
    if (stat?.isFile()) matches.push(candidate);
  }
  const expected = suite.receiptSurfaces?.length ?? 1;
  if (matches.length !== expected)
    throw new Error(`Expected ${expected} ${suite.id} cleanup receipts; found ${matches.length}.`);
  const surfaces = new Set(suite.receiptSurfaces);
  for (const path of matches.sort()) {
    const contents = await NodeFSP.readFile(path, "utf8");
    const receipt = JSON.parse(contents) as { surface?: string; peerControlsExercised?: boolean };
    let destination = "acceptance.json";
    if (suite.receiptSurfaces) {
      if (!receipt.surface || !surfaces.delete(receipt.surface))
        throw new Error(`Unexpected or duplicate ${suite.id} cleanup receipt surface.`);
      destination = `acceptance-${receipt.surface}.json`;
    }
    await NodeFSP.writeFile(NodePath.join(directory, destination), contents, {
      flag: "wx",
      mode: 0o600,
    });
    assertAcceptanceReceipt(receipt, suite.id === "packaged-upgrade");
    if (suite.id === "local-workflow" && receipt.peerControlsExercised !== true)
      throw new Error("Local workflow acceptance must exercise peer steering and stop controls.");
  }
}

export async function qualifyMeerkatRelease(options: QualificationOptions): Promise<void> {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- The release CLI checks the supported host before opening any fixture.
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error("Release qualification requires an Apple Silicon Mac.");
  for (const directory of [repoRoot, NodePath.join(repoRoot, "apps/server")]) {
    if (
      (await NodeFSP.readdir(directory)).some(
        (name) => /^\.env(?:\.|$)/.test(name) && !name.endsWith(".example"),
      )
    )
      throw new Error(
        "Use a checkout without local .env files for release qualification; no account configuration may enter these fixtures.",
      );
  }
  const before = await captureQualificationInputs(options);
  const suites = qualificationSuites(Boolean(options.currentApp));
  if (options.planOnly) {
    process.stdout.write(
      `${JSON.stringify({ inputs: before, suites, packagedAcceptance: Boolean(options.currentApp) }, null, 2)}\n`,
    );
    return;
  }
  await NodeFSP.mkdir(options.evidenceDirectory, { mode: 0o700 });
  // Keep socket paths short even when the caller stores evidence in a deeply nested directory.
  const temporaryRoot = await NodeFSP.mkdtemp("/tmp/mt3-q-");
  await NodeFSP.chmod(temporaryRoot, 0o700);
  const report: Record<string, unknown> = {
    schemaVersion: 1,
    status: "running",
    nodeVersion: process.version,
    inputs: before,
    temporaryRoot,
    packagedAcceptance: Boolean(options.currentApp),
    scope:
      "Built-server local/shared integration, packaged checks when requested and offline recovery contracts; no UI, OAuth, live model quality or general crash recovery qualification.",
    suites: [],
  };
  const results = report.suites as Record<string, unknown>[];
  const persist = async () => {
    const destination = NodePath.join(options.evidenceDirectory, "qualification.json");
    await NodeFSP.writeFile(`${destination}.tmp`, `${JSON.stringify(report, null, 2)}\n`, {
      mode: 0o600,
    });
    await NodeFSP.rename(`${destination}.tmp`, destination);
  };
  await persist();
  try {
    for (const suite of suites) {
      const root = NodePath.join(temporaryRoot, suite.id);
      const directory = NodePath.join(options.evidenceDirectory, suite.id);
      await NodeFSP.mkdir(directory, { mode: 0o700 });
      const env = qualificationEnvironment(options, root, suite, process.execPath);
      for (const path of [
        env.HOME!,
        env.TMPDIR!,
        env.XDG_CONFIG_HOME!,
        env.XDG_CACHE_HOME!,
        env.XDG_DATA_HOME!,
      ])
        await NodeFSP.mkdir(path, { recursive: true, mode: 0o700 });
      const json = NodePath.join(directory, "tests.json");
      const log = NodePath.join(directory, "test.log");
      const args = suite.nodeTest
        ? ["--test", "--test-reporter=tap", suite.file]
        : [
            NodePath.join(repoRoot, "node_modules/vite-plus/bin/vp"),
            "test",
            "run",
            suite.file,
            "--no-file-parallelism",
            "--maxWorkers=1",
            "--reporter=json",
            `--outputFile=${json}`,
          ];
      const result: Record<string, unknown> = {
        id: suite.id,
        status: "running",
        startedAt: new Date().toISOString(),
        temporaryRoot: root,
        file: suite.file,
      };
      results.push(result);
      await persist();
      process.stdout.write(`Release qualification: ${suite.id}\n`);
      const exit = await runSuite(
        args,
        suite.nodeTest ? repoRoot : NodePath.join(repoRoot, "apps/server"),
        env,
        log,
      );
      Object.assign(result, exit, { finishedAt: new Date().toISOString(), status: "failed" });
      // Retain a failed receipt too. Process exit zero alone is insufficient evidence.
      await retainQualificationReceipt(env.TMPDIR!, suite, directory);
      if (exit.code !== 0 || exit.signal)
        throw new Error(`${suite.id} exited unsuccessfully; inspect ${log}`);
      if (suite.nodeTest) assertNodeTestsPassed(await NodeFSP.readFile(log, "utf8"));
      else assertVitestPassed(JSON.parse(await NodeFSP.readFile(json, "utf8")));
      result.status = "passed";
      await persist();
    }
    const after = await captureQualificationInputs(options);
    if (JSON.stringify(before) !== JSON.stringify(after))
      throw new Error(
        "Acceptance inputs changed during qualification; rebuild and rerun against immutable inputs.",
      );
    report.inputsUnchanged = true;
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    await persist();
  }
  process.stdout.write(`Qualification passed. Evidence: ${options.evidenceDirectory}\n`);
}

if (import.meta.main) {
  try {
    await qualifyMeerkatRelease(parseQualificationOptions(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Release qualification failed"}\n`,
    );
    process.exitCode = 1;
  }
}
