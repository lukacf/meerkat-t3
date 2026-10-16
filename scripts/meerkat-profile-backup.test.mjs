import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodeURL from "node:url";
import {
  assertProfileOffline,
  assertMissingOriginalsOffline,
  createProfileBackup,
  restoreProfileBackup,
  verifyProfileBackup,
  readPersistedNativeRoots,
} from "./meerkat-profile-backup.mjs";

const closed = { assertOffline: async () => {}, readPersistedRoots: async () => [] };
const reviewMarker = "meerkat-restore-review.json";
const reviewCapability = "meerkat-restore-review-capability.json";

// oxlint-disable-next-line t3code/no-global-process-runtime -- These Node tests exercise the standalone CLI without Effect.
const platform = NodeOS.platform();

NodeTest.test("runs the CLI through a symlink instead of silently exiting", async (t) => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "meerkat-backup-cli-"));
  t.after(() => NodeFSP.rm(directory, { recursive: true, force: true }));
  const script = NodePath.join(directory, "profile-recovery.mjs");
  await NodeFSP.symlink(
    NodeURL.fileURLToPath(new URL("./meerkat-profile-backup.mjs", import.meta.url)),
    script,
  );
  const run = NodeUtil.promisify(NodeChildProcess.execFile);
  const help = await run(process.execPath, [script, "--help"]);
  NodeAssert.match(help.stdout, /Offline Meerkat T3 profile recovery/);
  await NodeAssert.rejects(
    run(process.execPath, [script, "verify", "--backup", NodePath.join(directory, "missing")]),
    (error) => {
      NodeAssert.equal(error.code, 1);
      NodeAssert.match(
        error.stderr,
        platform === "darwin"
          ? /Directory does not exist/
          : /currently supports the macOS pilot only/,
      );
      return true;
    },
  );
});

async function fixture(t, customNative = false) {
  const base = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "meerkat-backup-test-")),
  );
  t.after(() => NodeFSP.rm(base, { recursive: true, force: true }));
  const profile = NodePath.join(base, "profile");
  const desktopData = NodePath.join(base, "desktop");
  const output = NodePath.join(base, "backup");
  const native = customNative
    ? NodePath.join(base, "native")
    : NodePath.join(profile, "userdata/meerkat/meerkat/projects/project");
  const write = async (file, contents) => {
    await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
    await NodeFSP.writeFile(file, contents);
  };
  await write(
    NodePath.join(profile, reviewCapability),
    JSON.stringify({ version: 1, appVersion: "0.0.42-test" }),
  );
  await write(
    NodePath.join(profile, "userdata/settings.json"),
    JSON.stringify({
      providerInstances: {
        meerkat: { driver: "meerkat", config: customNative ? { stateRoot: native } : {} },
      },
      environment: { OPENAI_API_KEY: "fixture-key-not-real" },
    }),
  );
  await write(
    NodePath.join(profile, "userdata/state.sqlite"),
    "fixture: histories, queues, attention, project agents",
  );
  await write(NodePath.join(profile, "userdata/state.sqlite-wal"), "fixture WAL");
  await write(NodePath.join(profile, "userdata/state.sqlite-shm"), "fixture SHM");
  await write(NodePath.join(profile, "userdata/secrets/pairing-key"), "fixture pairing secret");
  await write(
    NodePath.join(profile, "userdata/attachments/image.png"),
    Buffer.from([0, 1, 2, 255]),
  );
  await write(NodePath.join(profile, "userdata/client-settings.json"), '{"theme":"dark"}');
  await write(NodePath.join(profile, "worktrees/task/important.txt"), "uncommitted worktree file");
  for (const file of [
    "mob.sqlite",
    "sessions.sqlite",
    "runtime.sqlite",
    "console.sqlite",
    "blobs/image",
    "peer/key",
    "topology-control.json",
  ]) {
    await write(NodePath.join(native, "mobkit/agent", file), `fixture native ${file}`);
  }
  await write(
    NodePath.join(desktopData, "Local Storage/leveldb/data"),
    "draft and desktop preferences",
  );
  await write(NodePath.join(desktopData, "Preferences"), "fixture browser preferences");
  await write(NodePath.join(profile, "userdata/server-runtime.json"), '{"pid":99999999}');
  await NodeFSP.symlink("stale-host-99999999", NodePath.join(desktopData, "SingletonLock"));
  const outside = NodePath.join(base, "outside");
  await write(NodePath.join(outside, "not-in-backup"), "external project dependency");
  await NodeFSP.symlink(outside, NodePath.join(profile, "worktrees/task/dependency"));
  return {
    base,
    profile,
    desktopData,
    output,
    native,
    appVersion: "0.0.42-test",
    confirmClosed: true,
    includeSecrets: true,
    retainedProfile: `${profile}.retained`,
    retainedDesktopData: `${desktopData}.retained`,
    retainedNativeStates: customNative ? [`${native}.retained`] : [],
  };
}

NodeTest.test(
  "captures all profile and desktop files, native stores, media, queues, secrets and worktrees",
  async (t) => {
    const f = await fixture(t);
    const manifest = await createProfileBackup(f, closed);
    NodeAssert.equal(manifest.containsSecrets, true);
    NodeAssert.equal(manifest.restoreReviewVersion, 1);
    NodeAssert.equal(manifest.recovery, "same-user-same-machine-same-path");
    NodeAssert.deepEqual(
      manifest.roots.map((root) => root.id),
      ["profile", "desktop"],
    );
    for (const relative of [
      "userdata/state.sqlite",
      "userdata/state.sqlite-wal",
      "userdata/state.sqlite-shm",
      "userdata/secrets/pairing-key",
      "userdata/attachments/image.png",
      "userdata/meerkat/meerkat/projects/project/mobkit/agent/sessions.sqlite",
      "userdata/meerkat/meerkat/projects/project/mobkit/agent/blobs/image",
      "worktrees/task/important.txt",
    ]) {
      NodeAssert.deepEqual(
        await NodeFSP.readFile(NodePath.join(f.output, "profile", relative)),
        await NodeFSP.readFile(NodePath.join(f.profile, relative)),
      );
    }
    NodeAssert.equal((await NodeFSP.stat(f.output)).mode & 0o777, 0o700);
    NodeAssert.equal(
      (await NodeFSP.stat(NodePath.join(f.output, "manifest.json"))).mode & 0o777,
      0o600,
    );
    NodeAssert.equal(
      await NodeFSP.readlink(NodePath.join(f.output, "profile/worktrees/task/dependency")),
      NodePath.join(f.base, "outside"),
    );
    NodeAssert.ok(!manifest.roots[0].entries.some((entry) => entry.path.includes("not-in-backup")));
    await NodeAssert.rejects(
      NodeFSP.lstat(NodePath.join(f.output, "profile/userdata/server-runtime.json")),
      { code: "ENOENT" },
    );
    await NodeAssert.rejects(NodeFSP.lstat(NodePath.join(f.output, "desktop/SingletonLock")), {
      code: "ENOENT",
    });
    NodeAssert.deepEqual(await verifyProfileBackup(f.output), manifest);
  },
);

NodeTest.test(
  "malformed settings do not expose pasted credentials through backup errors or CLI output",
  { skip: platform !== "darwin" },
  async (t) => {
    const f = await fixture(t);
    const settingsFile = NodePath.join(f.profile, "userdata/settings.json");
    const syntheticKey = "FAKE_BACKUP_KEY";
    await NodeFSP.writeFile(settingsFile, syntheticKey);
    const guidance =
      "Profile settings are not valid JSON. Keep the original file unchanged and repair it before backup. No backup was created.";
    await NodeAssert.rejects(createProfileBackup(f, closed), (error) => {
      NodeAssert.equal(error.message, guidance);
      NodeAssert.ok(!error.message.includes(syntheticKey));
      return true;
    });

    // This CLI fixture has no live server or saved database to inspect.
    for (const name of [
      "state.sqlite",
      "state.sqlite-wal",
      "state.sqlite-shm",
      "server-runtime.json",
    ]) {
      await NodeFSP.rm(NodePath.join(f.profile, "userdata", name));
    }
    const run = NodeUtil.promisify(NodeChildProcess.execFile);
    const script = NodeURL.fileURLToPath(new URL("./meerkat-profile-backup.mjs", import.meta.url));
    await NodeAssert.rejects(
      run(process.execPath, [
        script,
        "backup",
        "--profile",
        f.profile,
        "--desktop-data",
        f.desktopData,
        "--output",
        f.output,
        "--app-version",
        f.appVersion,
        "--confirm-closed",
        "--include-secrets",
      ]),
      (error) => {
        NodeAssert.equal(error.code, 1);
        NodeAssert.equal(error.stderr.trim(), guidance);
        NodeAssert.ok(!`${error.stdout}${error.stderr}`.includes(syntheticKey));
        return true;
      },
    );
    NodeAssert.equal(await NodeFSP.readFile(settingsFile, "utf8"), syntheticKey);
    await NodeAssert.rejects(NodeFSP.lstat(f.output), { code: "ENOENT" });
  },
);

for (const [name, contents] of [
  ["missing", undefined],
  ["malformed", "not JSON"],
  ["wrong build", JSON.stringify({ version: 1, appVersion: "older-build" })],
  ["unsupported", JSON.stringify({ version: 2, appVersion: "0.0.42-test" })],
  ["unexpected fields", JSON.stringify({ version: 1, appVersion: "0.0.42-test", trusted: true })],
  ["oversized", " ".repeat(4097)],
]) {
  NodeTest.test(
    `preserves a backup with ${name} restore capability but refuses to restore it`,
    async (t) => {
      const f = await fixture(t);
      if (contents === undefined) await NodeFSP.rm(NodePath.join(f.profile, reviewCapability));
      else await NodeFSP.writeFile(NodePath.join(f.profile, reviewCapability), contents);
      const manifest = await createProfileBackup(f, closed);
      NodeAssert.equal(Object.hasOwn(manifest, "restoreReviewVersion"), false);
      NodeAssert.deepEqual(await verifyProfileBackup(f.output), manifest);
      const manifestBytes = await NodeFSP.readFile(NodePath.join(f.output, "manifest.json"));
      for (const source of [f.profile, f.desktopData])
        await NodeFSP.rename(source, `${source}.retained`);
      const before = await NodeFSP.readdir(f.base);
      await NodeAssert.rejects(
        restoreProfileBackup({ ...f, backup: f.output }, closed),
        /Keep this archive unchanged.*fresh backup.*original profile is lost/,
      );
      NodeAssert.deepEqual(await NodeFSP.readdir(f.base), before);
      NodeAssert.deepEqual(
        await NodeFSP.readFile(NodePath.join(f.output, "manifest.json")),
        manifestBytes,
      );
      NodeAssert.deepEqual(await verifyProfileBackup(f.output), manifest);
      NodeAssert.equal(
        await NodeFSP.readFile(NodePath.join(f.retainedProfile, "userdata/state.sqlite"), "utf8"),
        "fixture: histories, queues, attention, project agents",
      );
    },
  );
}

NodeTest.test("does not accept a capability symlink as proof of restore support", async (t) => {
  const f = await fixture(t);
  const outside = NodePath.join(f.base, "external-capability.json");
  await NodeFSP.rename(NodePath.join(f.profile, reviewCapability), outside);
  await NodeFSP.symlink(outside, NodePath.join(f.profile, reviewCapability));
  const manifest = await createProfileBackup(f, closed);
  NodeAssert.equal(Object.hasOwn(manifest, "restoreReviewVersion"), false);
  NodeAssert.deepEqual(await verifyProfileBackup(f.output), manifest);
  NodeAssert.equal(
    await NodeFSP.readlink(NodePath.join(f.output, "profile", reviewCapability)),
    outside,
  );
  await NodeAssert.rejects(
    restoreProfileBackup({ ...f, backup: f.output }, closed),
    /without matching restore-review support/,
  );
});

NodeTest.test(
  "a manifest flag alone cannot turn an older archive into a guarded backup",
  async (t) => {
    const f = await fixture(t);
    await NodeFSP.rm(NodePath.join(f.profile, reviewCapability));
    const manifest = await createProfileBackup(f, closed);
    manifest.restoreReviewVersion = 1;
    await NodeFSP.writeFile(NodePath.join(f.output, "manifest.json"), JSON.stringify(manifest));
    await NodeAssert.rejects(verifyProfileBackup(f.output), /capability is missing or invalid/);
    await NodeAssert.rejects(
      restoreProfileBackup({ ...f, backup: f.output }, closed),
      /capability is missing or invalid/,
    );
  },
);

NodeTest.test("rejects unsupported guard metadata before preparing a restore", async (t) => {
  const f = await fixture(t);
  const manifest = await createProfileBackup(f, closed);
  for (const patch of [
    { restoreReviewVersion: 2 },
    { restoreReviewVersion: null },
    { createdAt: "not a date" },
    { createdAt: "2026-10-04" },
    { appVersion: "" },
  ]) {
    await NodeFSP.writeFile(
      NodePath.join(f.output, "manifest.json"),
      JSON.stringify({ ...manifest, ...patch }),
    );
    await NodeAssert.rejects(verifyProfileBackup(f.output), /restore-review/);
    await NodeAssert.rejects(
      restoreProfileBackup({ ...f, backup: f.output }, closed),
      /restore-review/,
    );
  }
  NodeAssert.equal(
    (await NodeFSP.readdir(f.base)).some((file) => file.startsWith(".meerkat-restore-")),
    false,
  );
});

NodeTest.test(
  "replaces inherited restore consent with a fresh marker without changing receipts or queues",
  async (t) => {
    const f = await fixture(t);
    const inherited = JSON.stringify({
      version: 1,
      restoreId: "71d33fb4-aa51-42b3-a08e-d0c9d5351169",
      restoredAt: "2026-10-01T12:00:00.000Z",
      backupCreatedAt: "2026-09-30T12:00:00.000Z",
      appVersion: f.appVersion,
      consentedAt: "2026-10-01T12:05:00.000Z",
    });
    await NodeFSP.writeFile(NodePath.join(f.profile, reviewMarker), inherited);
    const manifest = await createProfileBackup(f, closed);
    for (const source of [f.profile, f.desktopData])
      await NodeFSP.rename(source, `${source}.retained`);
    const beforeRestore = Date.now();
    await restoreProfileBackup({ ...f, backup: f.output }, closed);
    const first = JSON.parse(
      await NodeFSP.readFile(NodePath.join(f.profile, reviewMarker), "utf8"),
    );
    NodeAssert.match(
      first.restoreId,
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    );
    NodeAssert.notEqual(first.restoreId, JSON.parse(inherited).restoreId);
    NodeAssert.ok(
      Date.parse(first.restoredAt) >= beforeRestore && Date.parse(first.restoredAt) <= Date.now(),
    );
    NodeAssert.equal(new Date(first.restoredAt).toISOString(), first.restoredAt);
    NodeAssert.deepEqual(Object.keys(first).sort(), [
      "appVersion",
      "backupCreatedAt",
      "restoreId",
      "restoredAt",
      "version",
    ]);
    NodeAssert.equal(first.version, 1);
    NodeAssert.equal(first.appVersion, f.appVersion);
    NodeAssert.equal(first.backupCreatedAt, manifest.createdAt);
    NodeAssert.equal(
      (await NodeFSP.stat(NodePath.join(f.profile, reviewMarker))).mode & 0o777,
      0o600,
    );
    for (const file of [
      "userdata/state.sqlite",
      "userdata/state.sqlite-wal",
      "userdata/state.sqlite-shm",
      "userdata/meerkat/meerkat/projects/project/mobkit/agent/runtime.sqlite",
      "userdata/meerkat/meerkat/projects/project/mobkit/agent/sessions.sqlite",
    ]) {
      NodeAssert.deepEqual(
        await NodeFSP.readFile(NodePath.join(f.profile, file)),
        await NodeFSP.readFile(NodePath.join(f.output, "profile", file)),
      );
    }
    NodeAssert.equal(
      await NodeFSP.readFile(NodePath.join(f.output, "profile", reviewMarker), "utf8"),
      inherited,
    );
    NodeAssert.equal(
      await NodeFSP.readFile(NodePath.join(f.retainedProfile, reviewMarker), "utf8"),
      inherited,
    );
    NodeAssert.deepEqual(await verifyProfileBackup(f.output), manifest);
    for (const source of [f.profile, f.desktopData]) await NodeFSP.rm(source, { recursive: true });
    await restoreProfileBackup({ ...f, backup: f.output }, closed);
    const second = JSON.parse(
      await NodeFSP.readFile(NodePath.join(f.profile, reviewMarker), "utf8"),
    );
    NodeAssert.notEqual(second.restoreId, first.restoreId);
    NodeAssert.equal(Object.hasOwn(second, "consentedAt"), false);
  },
);

NodeTest.test("replaces a saved review marker symlink without writing through it", async (t) => {
  const f = await fixture(t);
  const target = NodePath.join(f.base, "external-review.json");
  await NodeFSP.writeFile(target, "external original");
  await NodeFSP.symlink(target, NodePath.join(f.profile, reviewMarker));
  await createProfileBackup(f, closed);
  for (const source of [f.profile, f.desktopData])
    await NodeFSP.rename(source, `${source}.retained`);
  await restoreProfileBackup({ ...f, backup: f.output }, closed);
  NodeAssert.equal((await NodeFSP.lstat(NodePath.join(f.profile, reviewMarker))).isFile(), true);
  NodeAssert.equal(await NodeFSP.readFile(target, "utf8"), "external original");
  NodeAssert.equal(
    await NodeFSP.readlink(NodePath.join(f.output, "profile", reviewMarker)),
    target,
  );
  NodeAssert.equal(await NodeFSP.readlink(NodePath.join(f.retainedProfile, reviewMarker)), target);
});

NodeTest.test(
  "publishes no roots when a fresh review marker cannot replace the saved entry",
  async (t) => {
    const f = await fixture(t, true);
    await NodeFSP.mkdir(NodePath.join(f.profile, reviewMarker));
    await NodeFSP.writeFile(NodePath.join(f.profile, reviewMarker, "preserve"), "original entry");
    const manifest = await createProfileBackup(f, closed);
    for (const source of [f.profile, f.desktopData, f.native])
      await NodeFSP.rename(source, `${source}.retained`);
    await NodeAssert.rejects(
      restoreProfileBackup({ ...f, backup: f.output, nativeStates: [f.native] }, closed),
      (error) => {
        NodeAssert.ok(["EISDIR", "ENOTDIR", "EEXIST"].includes(error.code));
        return true;
      },
    );
    for (const source of [f.profile, f.desktopData, f.native])
      await NodeAssert.rejects(NodeFSP.lstat(source), { code: "ENOENT" });
    NodeAssert.equal(
      (await NodeFSP.readdir(f.base)).some((file) => file.startsWith(".meerkat-restore-")),
      false,
    );
    NodeAssert.equal(
      await NodeFSP.readFile(NodePath.join(f.retainedProfile, reviewMarker, "preserve"), "utf8"),
      "original entry",
    );
    NodeAssert.deepEqual(await verifyProfileBackup(f.output), manifest);
  },
);

async function interceptFileSync(t, base, beforeSync) {
  const probePath = NodePath.join(base, "file-handle-probe");
  const probe = await NodeFSP.open(probePath, "wx");
  const prototype = Object.getPrototypeOf(probe);
  const sync = prototype.sync;
  await probe.close();
  await NodeFSP.rm(probePath);
  t.mock.method(prototype, "sync", async function () {
    await beforeSync(await this.stat());
    return sync.call(this);
  });
}

for (const failureAt of ["marker file", "staged directory"]) {
  NodeTest.test(
    `does not publish a restored profile when syncing its ${failureAt} fails`,
    async (t) => {
      const f = await fixture(t);
      const manifest = await createProfileBackup(f, closed);
      for (const source of [f.profile, f.desktopData])
        await NodeFSP.rename(source, `${source}.retained`);
      let markerSynced = false;
      await interceptFileSync(t, f.base, async (stat) => {
        for (const source of [f.profile, f.desktopData])
          await NodeAssert.rejects(NodeFSP.lstat(source), { code: "ENOENT" });
        if (stat.isFile()) {
          if (failureAt === "marker file") throw new Error("fixture marker sync failure");
          markerSynced = true;
        } else if (stat.isDirectory()) {
          NodeAssert.equal(markerSynced, true);
          throw new Error("fixture staged directory sync failure");
        }
      });
      await NodeAssert.rejects(
        restoreProfileBackup({ ...f, backup: f.output }, closed),
        /fixture .*sync failure/,
      );
      for (const source of [f.profile, f.desktopData])
        await NodeAssert.rejects(NodeFSP.lstat(source), { code: "ENOENT" });
      NodeAssert.equal(
        (await NodeFSP.readdir(f.base)).some((file) => file.startsWith(".meerkat-restore-")),
        false,
      );
      NodeAssert.deepEqual(await verifyProfileBackup(f.output), manifest);
      NodeAssert.equal(
        await NodeFSP.readFile(NodePath.join(f.retainedProfile, "userdata/state.sqlite"), "utf8"),
        "fixture: histories, queues, attention, project agents",
      );
    },
  );
}

NodeTest.test(
  "preserves a guarded partial restore when syncing its publication directory fails",
  async (t) => {
    const f = await fixture(t);
    const manifest = await createProfileBackup(f, closed);
    for (const source of [f.profile, f.desktopData])
      await NodeFSP.rename(source, `${source}.retained`);
    const parent = await NodeFSP.stat(f.base);
    let markerSynced = false;
    let profileDirectorySynced = false;
    await interceptFileSync(t, f.base, async (stat) => {
      if (stat.isFile()) markerSynced = true;
      else if (stat.dev === parent.dev && stat.ino === parent.ino) {
        NodeAssert.equal(markerSynced, true);
        NodeAssert.equal(profileDirectorySynced, true);
        const marker = JSON.parse(
          await NodeFSP.readFile(NodePath.join(f.profile, reviewMarker), "utf8"),
        );
        NodeAssert.equal(Object.hasOwn(marker, "consentedAt"), false);
        throw new Error("fixture publication sync failure");
      } else {
        NodeAssert.equal(markerSynced, true);
        await NodeAssert.rejects(NodeFSP.lstat(f.profile), { code: "ENOENT" });
        profileDirectorySynced = true;
      }
    });
    await NodeAssert.rejects(
      restoreProfileBackup({ ...f, backup: f.output }, closed),
      /fixture publication sync failure.*\nPartial restore retained at:/,
    );
    NodeAssert.equal((await NodeFSP.stat(f.profile)).isDirectory(), true);
    await NodeAssert.rejects(NodeFSP.lstat(f.desktopData), { code: "ENOENT" });
    NodeAssert.equal(
      (await NodeFSP.readdir(f.base)).some((file) => file.startsWith(".meerkat-restore-")),
      false,
    );
    NodeAssert.deepEqual(await verifyProfileBackup(f.output), manifest);
    NodeAssert.equal(
      await NodeFSP.readFile(NodePath.join(f.retainedProfile, "userdata/state.sqlite"), "utf8"),
      "fixture: histories, queues, attention, project agents",
    );
  },
);

NodeTest.test(
  "discovers configured external native state and requires it explicitly on restore",
  async (t) => {
    const f = await fixture(t, true);
    const manifest = await createProfileBackup(f, closed);
    NodeAssert.equal(manifest.roots[2].source, f.native);
    NodeAssert.equal(
      await NodeFSP.readFile(
        NodePath.join(f.output, "native-1/mobkit/agent/runtime.sqlite"),
        "utf8",
      ),
      "fixture native runtime.sqlite",
    );
    await NodeAssert.rejects(
      restoreProfileBackup({ ...f, backup: f.output }, closed),
      /every external --native-state/,
    );
    for (const source of [f.profile, f.desktopData, f.native])
      await NodeFSP.rename(source, `${source}.retained`);
    const restored = await restoreProfileBackup(
      { ...f, backup: f.output, nativeStates: [f.native] },
      closed,
    );
    NodeAssert.deepEqual(restored.restored, [f.profile, f.desktopData, f.native]);
    NodeAssert.equal(
      await NodeFSP.readFile(NodePath.join(f.native, "mobkit/agent/runtime.sqlite"), "utf8"),
      "fixture native runtime.sqlite",
    );
  },
);

NodeTest.test(
  "restores to original absent locations and retains the previous profile untouched",
  async (t) => {
    const f = await fixture(t);
    await createProfileBackup(f, closed);
    await NodeFSP.rename(f.profile, `${f.profile}.retained`);
    await NodeFSP.rename(f.desktopData, `${f.desktopData}.retained`);
    await restoreProfileBackup({ ...f, backup: f.output }, closed);
    NodeAssert.deepEqual(
      await NodeFSP.readFile(NodePath.join(f.profile, "userdata/attachments/image.png")),
      Buffer.from([0, 1, 2, 255]),
    );
    NodeAssert.equal(
      await NodeFSP.readFile(NodePath.join(f.desktopData, "Local Storage/leveldb/data"), "utf8"),
      "draft and desktop preferences",
    );
    NodeAssert.equal(
      await NodeFSP.readFile(
        NodePath.join(`${f.profile}.retained`, "userdata/state.sqlite"),
        "utf8",
      ),
      "fixture: histories, queues, attention, project agents",
    );
    await NodeAssert.rejects(
      NodeFSP.lstat(NodePath.join(f.profile, "userdata/server-runtime.json")),
      { code: "ENOENT" },
    );
  },
);

function missingOriginalsOptions(f) {
  const options = { ...f };
  delete options.retainedProfile;
  delete options.retainedDesktopData;
  delete options.retainedNativeStates;
  return { ...options, backup: f.output, originalsMissing: true };
}

NodeTest.test(
  "restores a verified backup after all original roots are lost without fabricating retained directories",
  async (t) => {
    const f = await fixture(t, true);
    await createProfileBackup(f, closed);
    for (const source of [f.profile, f.desktopData, f.native])
      await NodeFSP.rm(source, { recursive: true });
    let inspections = 0;
    const restored = await restoreProfileBackup(
      { ...missingOriginalsOptions(f), nativeStates: [f.native] },
      {
        ...closed,
        readProcesses: async () => {
          inspections++;
          return [];
        },
      },
    );
    NodeAssert.deepEqual(restored.restored, [f.profile, f.desktopData, f.native]);
    NodeAssert.equal(inspections, 2);
    NodeAssert.deepEqual(
      await NodeFSP.readFile(NodePath.join(f.profile, "userdata/attachments/image.png")),
      Buffer.from([0, 1, 2, 255]),
    );
    NodeAssert.equal(
      await NodeFSP.readFile(NodePath.join(f.desktopData, "Local Storage/leveldb/data"), "utf8"),
      "draft and desktop preferences",
    );
    NodeAssert.equal(
      await NodeFSP.readFile(NodePath.join(f.native, "mobkit/agent/sessions.sqlite"), "utf8"),
      "fixture native sessions.sqlite",
    );
    NodeAssert.equal(
      await NodeFSP.readFile(NodePath.join(f.profile, "userdata/state.sqlite-wal"), "utf8"),
      "fixture WAL",
    );
    NodeAssert.equal(
      await NodeFSP.readFile(NodePath.join(f.profile, "userdata/secrets/pairing-key"), "utf8"),
      "fixture pairing secret",
    );
    for (const retained of [f.retainedProfile, f.retainedDesktopData, ...f.retainedNativeStates])
      await NodeAssert.rejects(NodeFSP.stat(retained), { code: "ENOENT" });
  },
);

NodeTest.test(
  "missing-originals recovery rejects live recognizable apps, renamed packaged binaries, native hosts and Node servers",
  async () => {
    const executablePath = "/Applications/Custom Name.app/Contents/MacOS/Custom Binary";
    const active = [
      {
        executable:
          "/Applications/Meerkat T3 (Prototype).app/Contents/MacOS/Meerkat T3 (Prototype)",
        args: "",
      },
      {
        executable:
          "/tmp/Meerkat T3 (Nightly).app/Contents/Frameworks/Meerkat T3 Helper.app/Contents/MacOS/Meerkat T3 Helper",
        args: "",
      },
      { executable: executablePath, args: "" },
      { executable: "/tmp/runtime/meerkat-desktop-stdio", args: "" },
      {
        executable: "/opt/node",
        args: "/opt/node /source/apps/server/dist/bin.mjs --bootstrap-fd 3",
      },
      { executable: "/opt/node", args: "/opt/node /source/apps/server/src/bin.ts" },
    ];
    for (const entry of active) {
      await NodeAssert.rejects(
        assertMissingOriginalsOffline({
          ownPid: 10,
          executablePath,
          readProcesses: async () => [{ ...entry, pid: 20 }],
        }),
        /still running \(PID 20\)/,
      );
    }
    await assertMissingOriginalsOffline({
      ownPid: 10,
      executablePath,
      readProcesses: async () => [
        { pid: 10, executable: executablePath, args: "profile-backup.mjs restore" },
        { pid: 30, executable: "/opt/node", args: "/opt/node /unrelated/app.js" },
        {
          pid: 40,
          executable: "/opt/codex",
          args: "/opt/codex review /source/apps/server/dist/bin.mjs",
        },
        {
          pid: 50,
          executable: "/bin/zsh",
          args: "/bin/zsh -c 'cat /source/apps/server/dist/bin.mjs'",
        },
      ],
    });
  },
);

NodeTest.test(
  "missing-originals recovery fails closed on process inspection failure without leaking its output",
  async (t) => {
    const f = await fixture(t);
    await createProfileBackup(f, closed);
    await NodeFSP.rm(f.profile, { recursive: true });
    await NodeFSP.rm(f.desktopData, { recursive: true });
    await NodeAssert.rejects(
      restoreProfileBackup(missingOriginalsOptions(f), {
        ...closed,
        readProcesses: async () => {
          throw new Error("private command line and token");
        },
      }),
      (error) => {
        NodeAssert.match(error.message, /Cannot inspect running processes/);
        NodeAssert.doesNotMatch(error.message, /private command line|token/);
        return true;
      },
    );
    await NodeAssert.rejects(NodeFSP.stat(f.profile), { code: "ENOENT" });
    NodeAssert.ok(
      !(await NodeFSP.readdir(f.base)).some((name) => name.startsWith(".meerkat-restore-")),
    );
  },
);

NodeTest.test(
  "missing-originals recovery rechecks processes before publishing and cleans staged files on failure",
  async (t) => {
    const f = await fixture(t);
    await createProfileBackup(f, closed);
    await NodeFSP.rm(f.profile, { recursive: true });
    await NodeFSP.rm(f.desktopData, { recursive: true });
    let inspections = 0;
    await NodeAssert.rejects(
      restoreProfileBackup(missingOriginalsOptions(f), {
        ...closed,
        readProcesses: async () =>
          ++inspections === 1
            ? []
            : [{ pid: 20, executable: "/tmp/meerkat-desktop-stdio", args: "" }],
      }),
      /still running/,
    );
    NodeAssert.equal(inspections, 2);
    await NodeAssert.rejects(NodeFSP.stat(f.profile), { code: "ENOENT" });
    await NodeAssert.rejects(NodeFSP.stat(f.desktopData), { code: "ENOENT" });
    NodeAssert.ok(
      !(await NodeFSP.readdir(f.base)).some((name) => name.startsWith(".meerkat-restore-")),
    );
  },
);

NodeTest.test(
  "missing-originals recovery preserves a destination that appears during staging",
  async (t) => {
    const f = await fixture(t);
    await createProfileBackup(f, closed);
    await NodeFSP.rm(f.profile, { recursive: true });
    await NodeFSP.rm(f.desktopData, { recursive: true });
    let inspections = 0;
    await NodeAssert.rejects(
      restoreProfileBackup(missingOriginalsOptions(f), {
        ...closed,
        readProcesses: async () => {
          if (++inspections === 2) {
            await NodeFSP.mkdir(f.profile);
            await NodeFSP.writeFile(NodePath.join(f.profile, "new-data"), "keep");
          }
          return [];
        },
      }),
      /destination appeared/,
    );
    NodeAssert.equal(await NodeFSP.readFile(NodePath.join(f.profile, "new-data"), "utf8"), "keep");
    NodeAssert.deepEqual(await NodeFSP.readdir(f.profile), ["new-data"]);
    await NodeAssert.rejects(NodeFSP.stat(f.desktopData), { code: "ENOENT" });
    NodeAssert.ok(
      !(await NodeFSP.readdir(f.base)).some((name) => name.startsWith(".meerkat-restore-")),
    );
  },
);

NodeTest.test(
  "missing-originals recovery cannot skip retained-root checks or overwrite surviving originals",
  async (t) => {
    const f = await fixture(t);
    await createProfileBackup(f, closed);
    const offline = { ...closed, readProcesses: async () => [] };
    await NodeAssert.rejects(
      restoreProfileBackup(missingOriginalsOptions(f), offline),
      /refuses to overwrite/,
    );
    await NodeFSP.rename(f.profile, f.retainedProfile);
    await NodeFSP.rename(f.desktopData, f.retainedDesktopData);
    await NodeAssert.rejects(
      restoreProfileBackup({ ...f, backup: f.output, originalsMissing: true }, offline),
      /not both/,
    );
    NodeAssert.equal(
      await NodeFSP.readFile(NodePath.join(f.retainedProfile, "userdata/state.sqlite"), "utf8"),
      "fixture: histories, queues, attention, project agents",
    );
  },
);

NodeTest.test(
  "never overwrites an existing profile, backup destination, or a different restore location",
  async (t) => {
    const f = await fixture(t);
    await createProfileBackup(f, closed);
    await NodeAssert.rejects(createProfileBackup(f, closed), /already exists/);
    await NodeAssert.rejects(
      restoreProfileBackup({ ...f, backup: f.output }, closed),
      /refuses to overwrite/,
    );
    await NodeAssert.rejects(
      restoreProfileBackup(
        { ...f, profile: NodePath.join(f.base, "elsewhere"), backup: f.output },
        closed,
      ),
      /original backup locations/,
    );
    NodeAssert.equal(
      await NodeFSP.readFile(NodePath.join(f.profile, "userdata/state.sqlite"), "utf8"),
      "fixture: histories, queues, attention, project agents",
    );
  },
);

NodeTest.test("refuses active or changing sources without publishing a backup", async (t) => {
  const f = await fixture(t);
  await NodeAssert.rejects(
    createProfileBackup(f, {
      ...closed,
      assertOffline: async () => {
        throw new Error("busy profile");
      },
    }),
    /busy profile/,
  );
  await NodeAssert.rejects(NodeFSP.stat(f.output), { code: "ENOENT" });
  let calls = 0;
  await NodeAssert.rejects(
    createProfileBackup(f, {
      ...closed,
      assertOffline: async () => {
        if (++calls === 3)
          await NodeFSP.writeFile(
            NodePath.join(f.profile, "userdata/state.sqlite-wal"),
            "changed while copying",
          );
      },
    }),
    /Profile changed during backup/,
  );
  await NodeAssert.rejects(NodeFSP.stat(f.output), { code: "ENOENT" });
});

NodeTest.test("checks a saved live server PID without signalling it", async (t) => {
  const f = await fixture(t);
  await NodeFSP.writeFile(
    NodePath.join(f.profile, "userdata/server-runtime.json"),
    JSON.stringify({ pid: process.pid }),
  );
  await NodeAssert.rejects(
    assertProfileOffline([{ id: "profile", source: f.profile }]),
    /still exists/,
  );
});

NodeTest.test("rejects tampered payloads before creating restore directories", async (t) => {
  const f = await fixture(t);
  await createProfileBackup(f, closed);
  await NodeFSP.rename(f.profile, `${f.profile}.retained`);
  await NodeFSP.rename(f.desktopData, `${f.desktopData}.retained`);
  await NodeFSP.writeFile(NodePath.join(f.output, "profile/userdata/state.sqlite"), "corrupt");
  await NodeAssert.rejects(
    restoreProfileBackup({ ...f, backup: f.output }, closed),
    /checksum or content mismatch/,
  );
  await NodeAssert.rejects(NodeFSP.stat(f.profile), { code: "ENOENT" });
  await NodeAssert.rejects(NodeFSP.stat(f.desktopData), { code: "ENOENT" });
});

NodeTest.test(
  "a staging write failure publishes no profile and leaves retained data intact",
  { skip: process.getuid?.() === 0 },
  async (t) => {
    const f = await fixture(t);
    const desktopParent = NodePath.join(f.base, "desktop-parent");
    await NodeFSP.mkdir(desktopParent);
    const originalDesktop = f.desktopData;
    f.desktopData = NodePath.join(desktopParent, "desktop");
    f.retainedDesktopData = `${f.desktopData}.retained`;
    await NodeFSP.rename(originalDesktop, f.desktopData);
    await createProfileBackup(f, closed);
    await NodeFSP.rename(f.profile, `${f.profile}.retained`);
    await NodeFSP.rename(f.desktopData, `${f.desktopData}.retained`);
    await NodeFSP.chmod(desktopParent, 0o500);
    try {
      await NodeAssert.rejects(restoreProfileBackup({ ...f, backup: f.output }, closed), {
        code: "EACCES",
      });
      await NodeAssert.rejects(NodeFSP.stat(f.profile), { code: "ENOENT" });
      NodeAssert.ok((await NodeFSP.stat(`${f.profile}.retained`)).isDirectory());
      NodeAssert.ok(
        !(await NodeFSP.readdir(f.base)).some((name) => name.startsWith(".meerkat-restore-")),
      );
    } finally {
      await NodeFSP.chmod(desktopParent, 0o700);
    }
  },
);

NodeTest.test("rejects missing native files and unsupported backup format", async (t) => {
  const f = await fixture(t);
  await createProfileBackup(f, closed);
  await NodeFSP.rm(
    NodePath.join(
      f.output,
      "profile/userdata/meerkat/meerkat/projects/project/mobkit/agent/sessions.sqlite",
    ),
  );
  await NodeAssert.rejects(verifyProfileBackup(f.output), /checksum or content mismatch/);
  await NodeFSP.writeFile(NodePath.join(f.output, "manifest.json"), '{"version":999}');
  await NodeAssert.rejects(verifyProfileBackup(f.output), /Unsupported or incomplete/);
});

NodeTest.test(
  "requires every retained root and checks live PIDs at their moved locations",
  async (t) => {
    const f = await fixture(t);
    await createProfileBackup(f, closed);
    await NodeFSP.rename(f.profile, f.retainedProfile);
    await NodeFSP.rename(f.desktopData, f.retainedDesktopData);
    await NodeAssert.rejects(
      restoreProfileBackup({ ...f, backup: f.output, retainedProfile: undefined }, closed),
      /requires --retained-profile/,
    );
    await NodeFSP.writeFile(
      NodePath.join(f.retainedProfile, "userdata/server-runtime.json"),
      JSON.stringify({ pid: process.pid }),
    );
    await NodeAssert.rejects(restoreProfileBackup({ ...f, backup: f.output }), /still exists/);
    await NodeAssert.rejects(NodeFSP.stat(f.profile), { code: "ENOENT" });
    await NodeAssert.rejects(NodeFSP.stat(f.desktopData), { code: "ENOENT" });
    NodeAssert.ok(
      !(await NodeFSP.readdir(f.base)).some((name) => name.startsWith(".meerkat-restore-")),
    );
  },
);

NodeTest.test(
  "rechecks all moved-aside roots before publication and retains data on failure",
  async (t) => {
    const f = await fixture(t, true);
    await createProfileBackup(f, closed);
    for (const source of [f.profile, f.desktopData, f.native])
      await NodeFSP.rename(source, `${source}.retained`);
    const expected = [f.retainedProfile, f.retainedDesktopData, ...f.retainedNativeStates];
    let calls = 0;
    await NodeAssert.rejects(
      restoreProfileBackup(
        { ...f, backup: f.output, nativeStates: [f.native] },
        {
          assertOffline: async (roots) => {
            for (const source of expected)
              NodeAssert.ok(roots.some((root) => root.source === source));
            if (++calls === 2) throw new Error("retained native process reopened");
          },
        },
      ),
      /retained native process reopened/,
    );
    NodeAssert.equal(calls, 2);
    for (const source of [f.profile, f.desktopData, f.native])
      await NodeAssert.rejects(NodeFSP.stat(source), { code: "ENOENT" });
    for (const source of expected) NodeAssert.ok((await NodeFSP.stat(source)).isDirectory());
    NodeAssert.ok(
      !(await NodeFSP.readdir(f.base)).some((name) => name.startsWith(".meerkat-restore-")),
    );
  },
);

NodeTest.test(
  "rejects retained paths overlapping the backup and a retained root moved during staging",
  async (t) => {
    const f = await fixture(t);
    await createProfileBackup(f, closed);
    await NodeFSP.rename(f.profile, f.retainedProfile);
    await NodeFSP.rename(f.desktopData, f.retainedDesktopData);
    await NodeAssert.rejects(
      restoreProfileBackup(
        { ...f, backup: f.output, retainedProfile: NodePath.join(f.output, "profile") },
        closed,
      ),
      /must be separate/,
    );
    let calls = 0;
    await NodeAssert.rejects(
      restoreProfileBackup(
        { ...f, backup: f.output },
        {
          assertOffline: async () => {
            if (++calls === 1)
              await NodeFSP.rename(f.retainedDesktopData, `${f.retainedDesktopData}.moved-again`);
          },
        },
      ),
      /Directory does not exist/,
    );
    await NodeAssert.rejects(NodeFSP.stat(f.profile), { code: "ENOENT" });
    await NodeAssert.rejects(NodeFSP.stat(f.desktopData), { code: "ENOENT" });
    NodeAssert.ok(
      !(await NodeFSP.readdir(f.base)).some((name) => name.startsWith(".meerkat-restore-")),
    );
  },
);

NodeTest.test(
  "detects an open file in a moved-aside desktop profile",
  { skip: platform !== "darwin" },
  async (t) => {
    const f = await fixture(t);
    await createProfileBackup(f, closed);
    await NodeFSP.rename(f.profile, f.retainedProfile);
    await NodeFSP.rename(f.desktopData, f.retainedDesktopData);
    const handle = await NodeFSP.open(NodePath.join(f.retainedDesktopData, "Preferences"), "r");
    try {
      await NodeAssert.rejects(
        restoreProfileBackup({ ...f, backup: f.output }),
        /Profile has open files/,
      );
      await NodeAssert.rejects(NodeFSP.stat(f.profile), { code: "ENOENT" });
    } finally {
      await handle.close();
    }
  },
);

NodeTest.test("rejects path traversal and children of links in manifests", async (t) => {
  const f = await fixture(t);
  const original = await createProfileBackup(f, closed);
  for (const bad of [
    [{ path: "../escape", mode: 0o600, type: "directory" }],
    [
      { path: "link", mode: 0o700, type: "link", target: f.base },
      { path: "link/escape", mode: 0o700, type: "directory" },
    ],
  ]) {
    const manifest = structuredClone(original);
    manifest.roots[0].entries = bad;
    await NodeFSP.writeFile(NodePath.join(f.output, "manifest.json"), JSON.stringify(manifest));
    await NodeAssert.rejects(
      verifyProfileBackup(f.output),
      /Invalid or duplicate backup path|symbolic link/,
    );
  }
  await NodeAssert.rejects(NodeFSP.stat(NodePath.join(f.base, "escape")), { code: "ENOENT" });
});

NodeTest.test(
  "requires explicit closed/secret consent and the same version before restoring",
  async (t) => {
    const f = await fixture(t);
    await NodeAssert.rejects(
      createProfileBackup({ ...f, includeSecrets: false }, closed),
      /--include-secrets/,
    );
    await NodeAssert.rejects(
      createProfileBackup({ ...f, confirmClosed: false }, closed),
      /--confirm-closed/,
    );
    await createProfileBackup(f, closed);
    await NodeAssert.rejects(
      restoreProfileBackup({ ...f, backup: f.output, appVersion: "older" }, closed),
      /App version does not match/,
    );
  },
);

NodeTest.test("refuses nested backup outputs and symlinked profile roots", async (t) => {
  const f = await fixture(t);
  await NodeAssert.rejects(
    createProfileBackup({ ...f, output: NodePath.join(f.profile, "backup") }, closed),
    /outside every profile root/,
  );
  const alias = NodePath.join(f.base, "alias");
  await NodeFSP.symlink(f.profile, alias);
  await NodeAssert.rejects(createProfileBackup({ ...f, profile: alias }, closed), /real directory/);
});

NodeTest.test(
  "includes historical native roots even after provider configuration changes",
  async (t) => {
    const f = await fixture(t);
    const oldNative = NodePath.join(f.base, "old-native");
    await NodeFSP.mkdir(oldNative);
    await NodeFSP.writeFile(NodePath.join(oldNative, "sessions.sqlite"), "older native history");
    const manifest = await createProfileBackup(f, {
      ...closed,
      readPersistedRoots: async () => [{ source: oldNative, required: true }],
    });
    NodeAssert.equal(manifest.roots[2].source, oldNative);
    NodeAssert.equal(
      await NodeFSP.readFile(NodePath.join(f.output, "native-1/sessions.sqlite"), "utf8"),
      "older native history",
    );
  },
);

NodeTest.test(
  "discovers native references from a SQLite copy including pending WAL without changing source bytes",
  { skip: platform !== "darwin" },
  async (t) => {
    const f = await fixture(t);
    const { DatabaseSync } = await import("node:sqlite");
    const database = NodePath.join(f.profile, "userdata/state.sqlite");
    for (const suffix of ["", "-wal", "-shm"])
      await NodeFSP.rm(`${database}${suffix}`, { force: true });
    const db = new DatabaseSync(database);
    try {
      db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
      db.exec(
        "CREATE TABLE provider_session_runtime (provider_name TEXT, resume_cursor_json TEXT); CREATE TABLE meerkat_project_agents (provider_state_root TEXT, state_root TEXT); CREATE TABLE meerkat_peer_connections (provider_state_root TEXT); CREATE TABLE meerkat_observed_agents (provider_state_root TEXT, state_root TEXT); CREATE TABLE meerkat_workspace_checkpoints (state_root TEXT);",
      );
      db.prepare("INSERT INTO provider_session_runtime VALUES (?, ?)").run(
        "meerkat",
        JSON.stringify({ stateRoot: NodePath.join(f.base, "historic-thread") }),
      );
      db.prepare("INSERT INTO meerkat_project_agents VALUES (?, ?)").run(
        NodePath.join(f.base, "historic-provider"),
        NodePath.join(f.base, "historic-provider/agent"),
      );
      db.prepare("INSERT INTO meerkat_peer_connections VALUES (?)").run(
        NodePath.join(f.base, "historic-peers"),
      );
      db.prepare("INSERT INTO meerkat_observed_agents VALUES (?, ?)").run(
        NodePath.join(f.base, "observed"),
        null,
      );
      db.prepare("INSERT INTO meerkat_workspace_checkpoints VALUES (?)").run(
        NodePath.join(f.base, "checkpoint-history"),
      );
      const before = await Promise.all(
        ["", "-wal", "-shm"].map((suffix) => NodeFSP.readFile(`${database}${suffix}`)),
      );
      const roots = await readPersistedNativeRoots(f.profile);
      NodeAssert.deepEqual(
        new Set(roots.map((root) => root.source)),
        new Set(
          [
            "historic-thread",
            "historic-provider",
            "historic-provider/agent",
            "historic-peers",
            "observed",
            "checkpoint-history",
          ].map((relative) => NodePath.join(f.base, relative)),
        ),
      );
      NodeAssert.deepEqual(
        new Set(roots.filter((root) => !root.required).map((root) => root.source)),
        new Set(
          ["historic-provider", "historic-provider/agent", "historic-peers"].map((relative) =>
            NodePath.join(f.base, relative),
          ),
        ),
      );
      const after = await Promise.all(
        ["", "-wal", "-shm"].map((suffix) => NodeFSP.readFile(`${database}${suffix}`)),
      );
      NodeAssert.deepEqual(after, before);
    } finally {
      db.close();
    }
  },
);

for (const location of ["inside profile", "external"]) {
  NodeTest.test(
    `refuses a full backup when recorded agent history is missing ${location}`,
    async (t) => {
      const f = await fixture(t);
      const missing = NodePath.join(
        location === "inside profile" ? f.profile : f.base,
        "missing-history",
      );
      const settingsFile = NodePath.join(f.profile, "userdata/settings.json");
      const settings = JSON.parse(await NodeFSP.readFile(settingsFile, "utf8"));
      settings.providerInstances.meerkat.config.stateRoot = missing;
      await NodeFSP.writeFile(settingsFile, JSON.stringify(settings));
      const originalIndex = await NodeFSP.readFile(
        NodePath.join(f.profile, "userdata/state.sqlite"),
      );
      await NodeAssert.rejects(
        createProfileBackup(f, {
          ...closed,
          // A definition/configuration entry cannot make an observed history optional.
          readPersistedRoots: async () => [
            { source: missing, required: false },
            { source: missing, required: true },
          ],
        }),
        /Saved agent history references a missing directory.*No backup was created/,
      );
      await NodeAssert.rejects(NodeFSP.lstat(f.output), { code: "ENOENT" });
      NodeAssert.deepEqual(
        await NodeFSP.readFile(NodePath.join(f.profile, "userdata/state.sqlite")),
        originalIndex,
      );
    },
  );
}

NodeTest.test(
  "backs up an unconnected specialist definition and unused internal configuration without inventing history",
  async (t) => {
    const f = await fixture(t);
    const unused = NodePath.join(f.profile, "userdata/meerkat/never-connected");
    const settingsFile = NodePath.join(f.profile, "userdata/settings.json");
    const settings = JSON.parse(await NodeFSP.readFile(settingsFile, "utf8"));
    settings.providerInstances.meerkat.config.stateRoot = unused;
    await NodeFSP.writeFile(settingsFile, JSON.stringify(settings));
    const manifest = await createProfileBackup(f, {
      ...closed,
      readPersistedRoots: async () => [{ source: unused, required: false }],
    });
    NodeAssert.equal(manifest.restoreReviewVersion, 1);
    NodeAssert.deepEqual(await verifyProfileBackup(f.output), manifest);
    NodeAssert.deepEqual(
      await NodeFSP.readFile(NodePath.join(f.output, "profile/userdata/settings.json")),
      await NodeFSP.readFile(settingsFile),
    );
    await NodeAssert.rejects(NodeFSP.lstat(unused), { code: "ENOENT" });
  },
);

NodeTest.test(
  "a saved peer connection needs no history until a native agent has been observed there",
  { skip: platform !== "darwin" },
  async (t) => {
    const f = await fixture(t);
    const { DatabaseSync } = await import("node:sqlite");
    const database = NodePath.join(f.profile, "userdata/state.sqlite");
    const unused = NodePath.join(f.profile, "userdata/meerkat/unstarted-peers");
    for (const suffix of ["", "-wal", "-shm"])
      await NodeFSP.rm(`${database}${suffix}`, { force: true });
    const db = new DatabaseSync(database);
    try {
      db.exec(
        "CREATE TABLE meerkat_peer_connections (provider_state_root TEXT); CREATE TABLE meerkat_observed_agents (provider_state_root TEXT, state_root TEXT);",
      );
      db.prepare("INSERT INTO meerkat_peer_connections VALUES (?)").run(unused);
      const manifest = await createProfileBackup(f, { assertOffline: closed.assertOffline });
      NodeAssert.deepEqual(await verifyProfileBackup(f.output), manifest);
      await NodeAssert.rejects(NodeFSP.lstat(unused), { code: "ENOENT" });

      db.prepare("INSERT INTO meerkat_observed_agents VALUES (?, ?)").run(unused, null);
      const output = NodePath.join(f.base, "second-backup");
      const before = await NodeFSP.readFile(database);
      await NodeAssert.rejects(
        createProfileBackup({ ...f, output }, { assertOffline: closed.assertOffline }),
        /Saved agent history references a missing directory.*No backup was created/,
      );
      await NodeAssert.rejects(NodeFSP.lstat(output), { code: "ENOENT" });
      NodeAssert.deepEqual(await NodeFSP.readFile(database), before);
    } finally {
      db.close();
    }
  },
);
