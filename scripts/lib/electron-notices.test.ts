// @effect-diagnostics nodeBuiltinImport:off - Tests exercise the Electron packaging filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { stageElectronNotices } from "./electron-notices.ts";

const tempDirectories: string[] = [];
const LICENSE = "MIT License\r\nCopyright Electron contributors\r\n\r\n";
const CHROMIUM =
  "<!doctype html>\r\n<html><body>Third-party notices: \u00a9 Example</body></html>\r\n";

async function fixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-electron-notices-"));
  tempDirectories.push(root);
  const electronPackageDir = NodePath.join(root, "electron");
  const distDir = NodePath.join(electronPackageDir, "dist");
  await NodeFSP.mkdir(distDir, { recursive: true });
  await Promise.all([
    NodeFSP.writeFile(
      NodePath.join(electronPackageDir, "package.json"),
      '{"name":"electron","version":"44.4.2"}\n',
    ),
    NodeFSP.writeFile(NodePath.join(distDir, "version"), "44.4.2\n"),
    NodeFSP.writeFile(NodePath.join(distDir, "LICENSE"), LICENSE),
    NodeFSP.writeFile(NodePath.join(distDir, "LICENSES.chromium.html"), CHROMIUM),
  ]);
  return {
    distDir,
    input: {
      electronPackageDir,
      expectedVersion: "44.4.2",
      destinationDir: NodePath.join(root, "staged"),
    },
  };
}

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
});

describe("Electron notice staging", () => {
  it("copies both complete notices verbatim without modifying their sources", async () => {
    const { input, distDir } = await fixture();
    expect(await stageElectronNotices(input)).toEqual(["LICENSE", "LICENSES.chromium.html"]);
    expect((await NodeFSP.readdir(input.destinationDir)).sort()).toEqual([
      "LICENSE",
      "LICENSES.chromium.html",
    ]);
    for (const [file, expected] of [
      ["LICENSE", LICENSE],
      ["LICENSES.chromium.html", CHROMIUM],
    ] as const) {
      expect(
        new Uint8Array(await NodeFSP.readFile(NodePath.join(input.destinationDir, file))),
      ).toEqual(new TextEncoder().encode(expected));
      expect(await NodeFSP.readFile(NodePath.join(distDir, file), "utf8")).toBe(expected);
    }
  });

  it("accepts the package directory symlink used by pnpm", async () => {
    const { input } = await fixture();
    const linkedPackageDir = NodePath.join(NodePath.dirname(input.electronPackageDir), "linked");
    await NodeFSP.symlink(input.electronPackageDir, linkedPackageDir, "dir");
    await stageElectronNotices({ ...input, electronPackageDir: linkedPackageDir });
    expect(
      await NodeFSP.readFile(NodePath.join(input.destinationDir, "LICENSES.chromium.html"), "utf8"),
    ).toBe(CHROMIUM);
  });

  for (const fault of ["missing", "empty", "whitespace", "directory", "symlink"] as const) {
    it(`refuses ${fault} Chromium notices before creating the destination`, async () => {
      const { input, distDir } = await fixture();
      const chromiumPath = NodePath.join(distDir, "LICENSES.chromium.html");
      await NodeFSP.unlink(chromiumPath);
      if (fault === "empty") await NodeFSP.writeFile(chromiumPath, "");
      if (fault === "whitespace") await NodeFSP.writeFile(chromiumPath, " \r\n\t");
      if (fault === "directory") await NodeFSP.mkdir(chromiumPath);
      if (fault === "symlink")
        await NodeFSP.symlink(NodePath.join(distDir, "LICENSE"), chromiumPath);
      await expect(stageElectronNotices(input)).rejects.toThrow();
      await expect(NodeFSP.stat(input.destinationDir)).rejects.toMatchObject({ code: "ENOENT" });
    });
  }

  it("refuses an empty Electron license before creating the destination", async () => {
    const { input, distDir } = await fixture();
    await NodeFSP.writeFile(NodePath.join(distDir, "LICENSE"), "");
    await expect(stageElectronNotices(input)).rejects.toThrow("notice is empty: LICENSE");
    await expect(NodeFSP.stat(input.destinationDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  for (const mismatch of ["package", "distribution"] as const) {
    it(`refuses a ${mismatch} version different from the pinned version`, async () => {
      const { input, distDir } = await fixture();
      if (mismatch === "package") {
        await NodeFSP.writeFile(
          NodePath.join(input.electronPackageDir, "package.json"),
          '{"name":"electron","version":"44.4.1"}\n',
        );
      } else {
        await NodeFSP.writeFile(NodePath.join(distDir, "version"), "44.4.1\n");
      }
      await expect(stageElectronNotices(input)).rejects.toThrow("must both match 44.4.2");
      await expect(NodeFSP.stat(input.destinationDir)).rejects.toMatchObject({ code: "ENOENT" });
    });
  }

  it("refuses an existing destination without overwriting its contents", async () => {
    const { input } = await fixture();
    await NodeFSP.mkdir(input.destinationDir);
    await NodeFSP.writeFile(NodePath.join(input.destinationDir, "LICENSE"), "Retained notice\n");
    await expect(stageElectronNotices(input)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await NodeFSP.readFile(NodePath.join(input.destinationDir, "LICENSE"), "utf8")).toBe(
      "Retained notice\n",
    );
  });
});
