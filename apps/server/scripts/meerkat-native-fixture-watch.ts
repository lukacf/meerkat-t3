// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - the opt-in acceptance fixture owns this file watcher and its fallback timer.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

/** Observe an owned fixture file until its exact validator accepts it. The caller owns the deadline. */
export function watchFile<A>(path: string, inspect: (text: string) => A | undefined) {
  const waiting = Promise.withResolvers<A>();
  let reading = false,
    dirty = false,
    stopped = false;
  const check = async () => {
    if (stopped) return;
    if (reading) {
      dirty = true;
      return;
    }
    reading = true;
    try {
      const text = await NodeFSP.readFile(path, "utf8");
      if (stopped) return;
      const value = inspect(text);
      if (value !== undefined) {
        waiting.resolve(value);
        close();
      }
    } catch (error) {
      if (!stopped && !(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        waiting.reject(error);
        close();
      }
    } finally {
      reading = false;
      if (dirty) {
        dirty = false;
        void check();
      }
    }
  };
  // Atomic writes rename from a temporary subdirectory. Directory notifications
  // can be coalesced or omit the target basename, so every notification is a hint.
  const watcher = NodeFS.watch(NodePath.dirname(path), () => void check());
  // fs.watch is lossy. This is bounded by the caller's existing acceptance
  // deadline and removed on success, validation failure, interruption or close.
  const retry = setInterval(() => void check(), 250);
  retry.unref();
  function close() {
    if (stopped) return;
    stopped = true;
    clearInterval(retry);
    watcher.close();
  }
  watcher.once("error", (error) => {
    waiting.reject(error);
    close();
  });
  void check();
  void waiting.promise.catch(() => undefined);
  return { promise: waiting.promise, close };
}
