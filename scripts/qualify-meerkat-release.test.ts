// @effect-diagnostics nodeBuiltinImport:off - Qualification input tests use synthetic files and never execute fixture binaries.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  MEERKAT_RUNTIME_FILES,
  meerkatFileHash,
  meerkatTarget,
} from "@t3tools/shared/meerkatRuntime";
import { describe, expect, it, type TestContext } from "vite-plus/test";
import {
  assertAcceptanceReceipt,
  assertNodeTestsPassed,
  assertVitestPassed,
  captureQualificationInputs,
  parseQualificationOptions,
  qualificationEnvironment,
  qualificationSuites,
  retainQualificationReceipt,
  type QualificationSuite,
} from "./qualify-meerkat-release.ts";

const paths = [
  "--server-entry",
  "/candidate/bin.mjs",
  "--runtime-dir",
  "/candidate/runtime",
  "--evidence-dir",
  "/evidence/new",
];
const options = parseQualificationOptions(paths);
const passed = {
  success: true,
  numTotalTests: 1,
  numPassedTests: 1,
  numFailedTests: 0,
  numPendingTests: 0,
  testResults: [{ assertionResults: [{ status: "passed" }] }],
};

async function inputFixture(t: TestContext) {
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "meerkat-qualification-inputs-")),
  );
  t.onTestFinished(() => NodeFSP.rm(root, { recursive: true, force: true }));
  await NodeFSP.chmod(root, 0o700);
  const write = async (path: string, contents: string) => {
    await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
    await NodeFSP.writeFile(path, contents, { mode: 0o755 });
    return path;
  };
  const runtime = async (directory: string, version: string) => {
    const target = meerkatTarget();
    const files: Record<string, string> = {};
    for (const name of [target.binary, ...MEERKAT_RUNTIME_FILES, "fixture-extra.dat"]) {
      const content = `Synthetic ${version} ${name}, never executed.\n`;
      await write(NodePath.join(directory, name), content);
      files[name] = meerkatFileHash(Buffer.from(content));
    }
    const manifest = {
      format: 1,
      binary: target.binary,
      build: {
        gatewayVersion: version,
        meerkatVersion: version,
        mobkitVersion: version,
        cargoLockSha256: "a".repeat(64),
        platform: target.platform,
        arch: target.arch,
      },
      files,
    };
    const manifestPath = NodePath.join(directory, "manifest.json");
    const save = () => write(manifestPath, JSON.stringify(manifest));
    await save();
    return { directory, manifest, manifestPath, save };
  };
  const app = async (name: string, version: string) => {
    const path = NodePath.join(root, `${name}.app`);
    const archive = await write(
      NodePath.join(path, "Contents/Resources/app.asar"),
      `Synthetic ${name} archive.\n`,
    );
    const executable = await write(
      NodePath.join(path, "Contents/MacOS/MeerkaT3"),
      `Synthetic ${name} Electron executable, never executed.\n`,
    );
    return {
      path,
      archive,
      executable,
      runtime: await runtime(NodePath.join(path, "Contents/Resources/meerkat-runtime"), version),
    };
  };
  const staged = await runtime(NodePath.join(root, "runtime"), "0.9.2");
  const current = await app("current", "0.9.2");
  const previous = await app("previous", "0.9.1");
  const serverEntry = await write(NodePath.join(root, "server/bin.mjs"), "export {};\n");
  const chunk = await write(NodePath.join(root, "server/chunk.mjs"), "export const fixture = 1;\n");
  return {
    staged,
    current,
    previous,
    chunk,
    options: {
      serverEntry,
      runtimeDirectory: staged.directory,
      currentApp: current.path,
      previousApp: previous.path,
      evidenceDirectory: NodePath.join(root, "evidence"),
      planOnly: false,
    },
  };
}

async function receiptFixture(t: TestContext, suite: QualificationSuite) {
  const root = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "meerkat-qualification-receipts-"),
  );
  t.onTestFinished(() => NodeFSP.rm(root, { recursive: true, force: true }));
  const tmp = NodePath.join(root, "tmp");
  await NodeFSP.mkdir(tmp);
  let attempt = 0;
  return {
    async write(index: number, receipt: unknown) {
      const path = NodePath.join(tmp, `fixture-${index}`, suite.receipt!);
      await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
      await NodeFSP.writeFile(path, JSON.stringify(receipt));
      return path;
    },
    async retain() {
      const directory = NodePath.join(root, `results-${attempt++}`);
      await NodeFSP.mkdir(directory);
      await retainQualificationReceipt(tmp, suite, directory);
      return directory;
    },
  };
}

describe("release qualification admission and receipts", () => {
  it("requires exact artifact paths and an explicit pair for packaged upgrade acceptance", () => {
    for (const args of [
      [],
      paths.slice(0, 4),
      [...paths, "--current-app", "/current.app"],
      [...paths, "--previous-app", "/previous.app"],
      [...paths, "--server-entry", "/other"],
      [...paths, "--unknown"],
      [...paths, "--current-app", "relative"],
    ])
      expect(() => parseQualificationOptions(args)).toThrow();
    expect(
      parseQualificationOptions([
        ...paths,
        "--current-app",
        "/current.app",
        "--previous-app",
        "/previous.app",
        "--plan",
      ]),
    ).toMatchObject({ currentApp: "/current.app", previousApp: "/previous.app", planOnly: true });
    expect(qualificationSuites(false).map((suite) => suite.id)).not.toContain("packaged-upgrade");
    expect(qualificationSuites(false).map((suite) => suite.id)).toEqual([
      "local-workflow",
      "local-steering",
      "local-queue-reconnect",
      "local-specialist-revision",
      "shared-specialists",
      "shared-expansion",
      "shared-tls",
      "shared-composition",
      "offline-recovery-contracts",
    ]);
    expect(qualificationSuites(true).map((suite) => suite.id)).toEqual(
      expect.arrayContaining(["packaged-upgrade", "packaged-checkpoints", "packaged-no-host"]),
    );
  });

  it("constructs a private environment from explicit inputs without inheriting process configuration", () => {
    const suite = qualificationSuites(false).find((candidate) => candidate.tls)!;
    const env = qualificationEnvironment(options, "/tmp/owned", suite, "/toolchain/node");
    expect(env.HOME).toBe("/tmp/owned/home");
    expect(env.TMPDIR).toBe("/tmp/owned/tmp");
    expect(env.T3CODE_TEST_SHARED_TLS).toBe("1");
    expect(env.PATH).toBe("/toolchain:/usr/bin:/bin:/usr/sbin:/sbin");
    for (const key of [
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "GITHUB_TOKEN",
      "NODE_OPTIONS",
      "NODE_EXTRA_CA_CERTS",
      "HTTP_PROXY",
      "T3CODE_HOME",
      "MEERKAT_STATE_ROOT",
      "T3CODE_TEST_MEERKAT_WORKFLOW_ACTIVE_DELETE_ONLY",
      "T3CODE_TEST_MEERKAT_SERVER_EXECUTABLE",
    ])
      expect(env).not.toHaveProperty(key);
    expect(
      qualificationEnvironment(
        options,
        "/tmp/owned",
        qualificationSuites(false)[0]!,
        "/toolchain/node",
      ),
    ).not.toHaveProperty("T3CODE_TEST_SHARED_TLS");
  });

  it("rejects a green runner with no executed tests, skips, todo or missing assertions", () => {
    expect(() => assertVitestPassed(passed)).not.toThrow();
    for (const report of [
      { ...passed, numTotalTests: 0, numPassedTests: 0, testResults: [] },
      { ...passed, numPendingTests: 1 },
      { ...passed, numTodoTests: 1 },
      { ...passed, numFailedTests: 1 },
      { ...passed, testResults: [] },
      { ...passed, testResults: [{ assertionResults: [{ status: "skipped" }] }] },
      { ...passed, success: false },
    ])
      expect(() => assertVitestPassed(report)).toThrow();
  });

  it("requires explicit completed cleanup, including packaged upgrade failure evidence", () => {
    expect(() =>
      assertAcceptanceReceipt({ passed: true, cleanupComplete: true, providerErrors: [] }, false),
    ).not.toThrow();
    expect(() => assertAcceptanceReceipt({ pass: true, failures: [] }, true)).not.toThrow();
    for (const receipt of [
      { passed: true },
      { passed: true, cleanupComplete: false },
      { passed: false, cleanupComplete: true },
      { passed: true, cleanupComplete: true, providerErrors: ["fixture failed"] },
    ])
      expect(() => assertAcceptanceReceipt(receipt, false)).toThrow();
    expect(() => assertAcceptanceReceipt({ pass: true }, true)).toThrow();
    expect(() =>
      assertAcceptanceReceipt({ pass: true, failures: ["cleanup failed"] }, true),
    ).toThrow();
  });

  it("requires every offline recovery contract to run rather than accepting platform skips", () => {
    const tap = "# tests 12\n# pass 12\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n";
    expect(() => assertNodeTestsPassed(tap)).not.toThrow();
    expect(() => assertNodeTestsPassed(tap.replace("# skipped 0", "# skipped 1"))).toThrow();
    expect(() => assertNodeTestsPassed(tap.replace("# cancelled 0", "# cancelled 1"))).toThrow();
    expect(() => assertNodeTestsPassed("# tests 0\n# pass 0\n# fail 0\n")).toThrow();
  });

  it("requires one retained successful steering receipt for every distinct public surface", async (t) => {
    const suite = qualificationSuites(false).find(
      (candidate) => candidate.id === "local-steering",
    )!;
    const f = await receiptFixture(t, suite);
    const success = { passed: true, cleanupComplete: true, providerErrors: [] };
    await f.write(0, { ...success, surface: "thread" });
    await f.write(1, { ...success, surface: "project-agent" });
    await expect(f.retain()).rejects.toThrow("Expected 3 local-steering cleanup receipts; found 2");
    await f.write(2, { ...success, surface: "thread" });
    await expect(f.retain()).rejects.toThrow("Unexpected or duplicate");
    await f.write(2, { ...success, surface: "owned-child", cleanupComplete: false });
    await expect(f.retain()).rejects.toThrow("successful assertions and owned cleanup");
    await f.write(2, { ...success, surface: "owned-child" });
    const directory = await f.retain();
    expect((await NodeFSP.readdir(directory)).sort()).toEqual([
      "acceptance-owned-child.json",
      "acceptance-project-agent.json",
      "acceptance-thread.json",
    ]);
  });

  it("rejects workflow acceptance that disabled peer controls even when the runner passed", async (t) => {
    const suite = qualificationSuites(false).find(
      (candidate) => candidate.id === "local-workflow",
    )!;
    const f = await receiptFixture(t, suite);
    const success = { passed: true, cleanupComplete: true };
    await f.write(0, { ...success, peerControlsExercised: false });
    await expect(f.retain()).rejects.toThrow("must exercise peer steering and stop controls");
    await f.write(0, { ...success, peerControlsExercised: true });
    const directory = await f.retain();
    expect(await NodeFSP.readdir(directory)).toEqual(["acceptance.json"]);
  });

  it("binds both packaged executables and every declared runtime file while allowing a different previous runtime", async (t) => {
    const f = await inputFixture(t);
    // Equivalent manifest formatting and property order are not a different runtime.
    await NodeFSP.writeFile(
      f.current.runtime.manifestPath,
      JSON.stringify(
        {
          ...f.current.runtime.manifest,
          files: Object.fromEntries(Object.entries(f.current.runtime.manifest.files).toReversed()),
        },
        null,
        2,
      ),
    );
    const before = await captureQualificationInputs(f.options);
    for (const app of [f.current, f.previous]) {
      expect(before[app.archive]).toMatch(/^[a-f0-9]{64}$/);
      expect(before[app.executable]).toMatch(/^[a-f0-9]{64}$/);
      expect(before[app.runtime.manifestPath]).toMatch(/^[a-f0-9]{64}$/);
      for (const [file, digest] of Object.entries(app.runtime.manifest.files))
        expect(before[NodePath.join(app.runtime.directory, file)]).toBe(digest);
    }
    expect(before[f.chunk]).toMatch(/^[a-f0-9]{64}$/);
    expect(await captureQualificationInputs(f.options)).toEqual(before);
    for (const app of [f.current, f.previous]) {
      await NodeFSP.appendFile(app.executable, "Changed executable.\n");
      const after = await captureQualificationInputs(f.options);
      expect(after[app.executable]).not.toBe(before[app.executable]);
      expect(after[app.archive]).toBe(before[app.archive]);
    }
  });

  it("rejects differing current runtime bytes and build identity even when both manifests validate", async (t) => {
    const f = await inputFixture(t);
    f.current.runtime.manifest.build.cargoLockSha256 = "b".repeat(64);
    await f.current.runtime.save();
    await expect(captureQualificationInputs(f.options)).rejects.toThrow(
      "Current packaged runtime does not match the staged qualification runtime",
    );
    f.current.runtime.manifest.build.cargoLockSha256 = "a".repeat(64);
    const file = "fixture-extra.dat";
    const changed = "Different packaged input.\n";
    await NodeFSP.writeFile(NodePath.join(f.current.runtime.directory, file), changed);
    f.current.runtime.manifest.files[file] = meerkatFileHash(Buffer.from(changed));
    await f.current.runtime.save();
    await expect(captureQualificationInputs(f.options)).rejects.toThrow(
      "Current packaged runtime does not match the staged qualification runtime",
    );
  });

  it("detects altered previous runtime bytes, including a correctly updated manifest outside app.asar", async (t) => {
    const f = await inputFixture(t);
    const before = await captureQualificationInputs(f.options);
    const file = "fixture-extra.dat";
    const path = NodePath.join(f.previous.runtime.directory, file);
    const changed = "Changed previous runtime resource.\n";
    await NodeFSP.writeFile(path, changed);
    await expect(captureQualificationInputs(f.options)).rejects.toThrow(
      "does not match its manifest",
    );
    f.previous.runtime.manifest.files[file] = meerkatFileHash(Buffer.from(changed));
    await f.previous.runtime.save();
    const after = await captureQualificationInputs(f.options);
    expect(after[path]).not.toBe(before[path]);
    expect(after[f.previous.runtime.manifestPath]).not.toBe(
      before[f.previous.runtime.manifestPath],
    );
    expect(after[f.previous.archive]).toBe(before[f.previous.archive]);
  });

  it("rejects a missing packaged executable or declared resource before starting any suite", async (t) => {
    const f = await inputFixture(t);
    await NodeFSP.rm(NodePath.join(f.current.runtime.directory, "fixture-extra.dat"));
    await expect(captureQualificationInputs(f.options)).rejects.toThrow();
    await NodeFSP.rm(f.previous.executable);
    await expect(
      captureQualificationInputs({ ...f.options, currentApp: f.previous.path }),
    ).rejects.toThrow("requires exactly one application executable");
  });
});
