#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - invoke the server-owned provisioner with its canonical transport.
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
const child = NodeChildProcess.spawn(
  process.execPath,
  [
    NodeURL.fileURLToPath(
      new URL("../apps/server/scripts/build-meerkat-runtime.ts", import.meta.url),
    ),
    ...process.argv.slice(2),
  ],
  { stdio: "inherit", shell: false },
);
child.on("error", (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
