// @effect-diagnostics nodeBuiltinImport:off - Packaging preserves exact Electron distribution notice bytes.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

const decodePackage = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({ name: Schema.Literal("electron"), version: Schema.String }),
  ),
);
const NOTICE_FILES = ["LICENSE", "LICENSES.chromium.html"] as const;

async function readRegularFile(file: string): Promise<Uint8Array> {
  const handle = await NodeFSP.open(
    file,
    NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
  );
  try {
    if (!(await handle.stat()).isFile()) throw new Error(`Not a regular file: ${file}`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export async function stageElectronNotices(input: {
  readonly electronPackageDir: string;
  readonly expectedVersion: string;
  readonly destinationDir: string;
}): Promise<typeof NOTICE_FILES> {
  const text = new TextDecoder();
  const packageJson = decodePackage(
    text.decode(await readRegularFile(NodePath.join(input.electronPackageDir, "package.json"))),
  );
  const distDir = NodePath.join(input.electronPackageDir, "dist");
  const distVersion = text.decode(await readRegularFile(NodePath.join(distDir, "version"))).trim();
  if (
    input.expectedVersion.length === 0 ||
    packageJson.version !== input.expectedVersion ||
    distVersion !== input.expectedVersion
  ) {
    throw new Error(`Electron package and distribution must both match ${input.expectedVersion}`);
  }

  const payloads = await Promise.all(
    NOTICE_FILES.map(async (file) => {
      const bytes = await readRegularFile(NodePath.join(distDir, file));
      if (text.decode(bytes).trim().length === 0) {
        throw new Error(`Electron distribution notice is empty: ${file}`);
      }
      return { file, bytes };
    }),
  );

  // Validate every input before creating output; retain the exact bytes read above.
  await NodeFSP.mkdir(input.destinationDir);
  for (const { file, bytes } of payloads) {
    await NodeFSP.writeFile(NodePath.join(input.destinationDir, file), bytes, {
      flag: "wx",
      mode: 0o644,
    });
  }
  return NOTICE_FILES;
}
