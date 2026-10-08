import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { watchFile } from "./meerkat-native-fixture-watch.ts";

const io = vi.hoisted(() => ({
  readFile: vi.fn<() => Promise<string>>(),
  close: vi.fn(),
  onEvent: undefined as ((event: string, filename: string | null) => void) | undefined,
  onError: undefined as ((error: Error) => void) | undefined,
}));
vi.mock("node:fs/promises", () => ({ readFile: io.readFile }));
vi.mock("node:fs", () => ({
  watch: (_path: string, onEvent: (event: string, filename: string | null) => void) => {
    io.onEvent = onEvent;
    return {
      close: io.close,
      once: (_event: string, onError: (error: Error) => void) => {
        io.onError = onError;
      },
    };
  },
}));

let active: ReturnType<typeof watchFile<string>> | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  io.readFile
    .mockReset()
    .mockRejectedValue(Object.assign(new Error("Missing"), { code: "ENOENT" }));
  io.close.mockClear();
});
afterEach(() => {
  active?.close();
  active = undefined;
  vi.useRealTimers();
});

it("accepts an atomic write after any directory notification, including a coalesced temporary-directory event", async () => {
  active = watchFile("/owned/userdata/server-runtime.json", (text) =>
    text === "valid" ? text : undefined,
  );
  await vi.advanceTimersByTimeAsync(0);
  io.readFile.mockResolvedValue("valid");
  io.onEvent!("rename", "server-runtime.json.temporary-directory");
  await expect(active.promise).resolves.toBe("valid");
  expect(io.close).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("recovers a dropped notification and stops all retries after the exact validator accepts", async () => {
  active = watchFile("/owned/userdata/server-runtime.json", (text) =>
    text === "valid" ? text : undefined,
  );
  await vi.advanceTimersByTimeAsync(0);
  io.readFile.mockResolvedValue("valid");
  await vi.advanceTimersByTimeAsync(250);
  await expect(active.promise).resolves.toBe("valid");
  const reads = io.readFile.mock.calls.length;
  await vi.advanceTimersByTimeAsync(1000);
  expect(io.readFile).toHaveBeenCalledTimes(reads);
  expect(io.close).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("rejects a descriptor validation failure instead of retrying it until a deadline", async () => {
  const mismatch = new Error("Origin does not match the isolated fixture");
  io.readFile.mockResolvedValue("wrong descriptor");
  active = watchFile("/owned/userdata/server-runtime.json", () => {
    throw mismatch;
  });
  await expect(active.promise).rejects.toBe(mismatch);
  expect(io.close).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("does not overlap reads or inspect an in-flight read after the fixture closes", async () => {
  const pending = Promise.withResolvers<string>();
  io.readFile.mockReturnValue(pending.promise);
  const inspect = vi.fn((text: string) => text);
  active = watchFile("/owned/userdata/server-runtime.json", inspect);
  io.onEvent!("change", null);
  await vi.advanceTimersByTimeAsync(750);
  expect(io.readFile).toHaveBeenCalledTimes(1);
  active.close();
  pending.resolve("valid");
  await vi.advanceTimersByTimeAsync(1000);
  expect(inspect).not.toHaveBeenCalled();
  expect(io.readFile).toHaveBeenCalledTimes(1);
  expect(io.close).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("propagates a watcher failure and releases its fallback timer", async () => {
  active = watchFile("/owned/userdata/server-runtime.json", (text) => text);
  const failure = new Error("Directory watcher lost");
  io.onError!(failure);
  await expect(active.promise).rejects.toBe(failure);
  expect(vi.getTimerCount()).toBe(0);
  expect(io.close).toHaveBeenCalledTimes(1);
});
