import { assert, describe, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { beforeEach, vi } from "vite-plus/test";

const storage = vi.hoisted(() => ({
  isAsyncEncryptionAvailable: vi.fn(),
  encryptStringAsync: vi.fn(),
  decryptStringAsync: vi.fn(),
  isEncryptionAvailable: vi.fn(() => {
    throw new Error("Synchronous Keychain access blocks the desktop");
  }),
  encryptString: vi.fn(() => {
    throw new Error("Synchronous Keychain access blocks the desktop");
  }),
  decryptString: vi.fn(() => {
    throw new Error("Synchronous Keychain access blocks the desktop");
  }),
}));

vi.mock("electron", () => ({ safeStorage: storage }));

import * as ElectronSafeStorage from "./ElectronSafeStorage.ts";

const make = ElectronSafeStorage.make.pipe(Effect.provideService(HostProcessPlatform, "darwin"));

describe("ElectronSafeStorage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storage.isAsyncEncryptionAvailable.mockResolvedValue(true);
    storage.encryptStringAsync.mockResolvedValue(Buffer.from("protected"));
    storage.decryptStringAsync.mockResolvedValue({
      result: "saved catalog",
      shouldReEncrypt: false,
    });
  });

  it.effect("allows the event loop to continue while Keychain encryption is pending", () =>
    Effect.gen(function* () {
      let complete!: (value: Buffer) => void;
      storage.encryptStringAsync.mockReturnValue(
        new Promise<Buffer>((resolve) => {
          complete = resolve;
        }),
      );
      const service = yield* make;
      let saved = false;
      const operation = yield* service.encryptString("catalog").pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            saved = true;
          }),
        ),
        Effect.forkChild,
      );
      yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
      assert.isFalse(saved);
      assert.equal(storage.encryptStringAsync.mock.calls.length, 1);
      assert.equal(storage.encryptString.mock.calls.length, 0);
      complete(Buffer.from("protected"));
      assert.deepEqual(yield* Fiber.join(operation), Buffer.from("protected"));
    }),
  );

  it.effect(
    "keeps unavailable storage unavailable without a synchronous or plaintext fallback",
    () =>
      Effect.gen(function* () {
        storage.isAsyncEncryptionAvailable.mockResolvedValue(false);
        const service = yield* make;
        assert.isFalse(yield* service.isEncryptionAvailable);
        assert.equal(storage.isEncryptionAvailable.mock.calls.length, 0);
        assert.equal(storage.encryptStringAsync.mock.calls.length, 0);
      }),
  );

  it.effect("returns saved plaintext from the asynchronous decrypt result", () =>
    Effect.gen(function* () {
      storage.decryptStringAsync.mockResolvedValue({
        result: "saved catalog",
        shouldReEncrypt: true,
      });
      const service = yield* make;
      assert.equal(yield* service.decryptString(new Uint8Array([1, 2, 3])), "saved catalog");
      assert.deepEqual(storage.decryptStringAsync.mock.calls, [[Buffer.from([1, 2, 3])]]);
      assert.equal(storage.decryptString.mock.calls.length, 0);
    }),
  );

  it.effect("preserves typed failures when the OS rejects access", () =>
    Effect.gen(function* () {
      const denied = new Error("Keychain access denied");
      storage.isAsyncEncryptionAvailable.mockRejectedValue(denied);
      storage.encryptStringAsync.mockRejectedValue(denied);
      storage.decryptStringAsync.mockRejectedValue(denied);
      const service = yield* make;
      const availability = yield* Effect.flip(service.isEncryptionAvailable);
      const encryption = yield* Effect.flip(service.encryptString("catalog"));
      const decryption = yield* Effect.flip(service.decryptString(new Uint8Array()));
      assert.instanceOf(availability, ElectronSafeStorage.ElectronSafeStorageAvailabilityError);
      assert.instanceOf(encryption, ElectronSafeStorage.ElectronSafeStorageEncryptError);
      assert.instanceOf(decryption, ElectronSafeStorage.ElectronSafeStorageDecryptError);
      assert.equal(availability.cause, denied);
      assert.equal(encryption.cause, denied);
      assert.equal(decryption.cause, denied);
    }),
  );
});
