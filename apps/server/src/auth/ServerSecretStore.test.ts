import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as PlatformError from "effect/PlatformError";

import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

const makeServerConfigLayer = () =>
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-secret-store-test-" });

const makeServerSecretStoreLayer = () =>
  Layer.provide(ServerSecretStore.layer, makeServerConfigLayer());

const PermissionDeniedFileSystemLayer = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    return {
      ...fileSystem,
      readFile: (path) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "readFile",
            pathOrDescriptor: path,
            description: "Permission denied while reading secret file.",
          }),
        ),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(NodeServices.layer));

const makePermissionDeniedSecretStoreLayer = () =>
  ServerSecretStore.layer.pipe(
    Layer.provide(makeServerConfigLayer()),
    Layer.provideMerge(PermissionDeniedFileSystemLayer),
  );

const RenameFailureFileSystemLayer = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    return {
      ...fileSystem,
      rename: (from, to) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "rename",
            pathOrDescriptor: `${String(from)} -> ${String(to)}`,
            description: "Permission denied while persisting secret file.",
          }),
        ),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(NodeServices.layer));

const makeRenameFailureSecretStoreLayer = () =>
  ServerSecretStore.layer.pipe(
    Layer.provide(makeServerConfigLayer()),
    Layer.provideMerge(RenameFailureFileSystemLayer),
  );

const RemoveFailureFileSystemLayer = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    return {
      ...fileSystem,
      remove: (path, options) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "remove",
            pathOrDescriptor: String(path),
            description: `Permission denied while removing secret file.${options ? " options-set" : ""}`,
          }),
        ),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(NodeServices.layer));

const makeRemoveFailureSecretStoreLayer = () =>
  ServerSecretStore.layer.pipe(
    Layer.provide(makeServerConfigLayer()),
    Layer.provideMerge(RemoveFailureFileSystemLayer),
  );

const ConcurrentReadMissFileSystemLayer = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const readCountRef = yield* Ref.make(0);
    const readBarrier = yield* Deferred.make<void>();

    return {
      ...fileSystem,
      readFile: (path) =>
        /[\\/]session-signing-key\.bin$/.test(String(path))
          ? Ref.updateAndGet(readCountRef, (count) => count + 1).pipe(
              Effect.flatMap((count) => {
                if (count > 2) {
                  return fileSystem.readFile(path);
                }
                return Effect.gen(function* () {
                  if (count === 2) {
                    yield* Deferred.succeed(readBarrier, void 0);
                  }
                  yield* Deferred.await(readBarrier);
                  return yield* Effect.failCause(
                    Cause.fail(
                      PlatformError.systemError({
                        _tag: "NotFound",
                        module: "FileSystem",
                        method: "readFile",
                        pathOrDescriptor: String(path),
                        description: "Secret file does not exist yet.",
                      }),
                    ),
                  );
                });
              }),
            )
          : fileSystem.readFile(path),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(NodeServices.layer));

const makeConcurrentCreateSecretStoreLayer = () =>
  ServerSecretStore.layer.pipe(
    Layer.provide(makeServerConfigLayer()),
    Layer.provideMerge(ConcurrentReadMissFileSystemLayer),
  );

// Pause a real write after its first half reaches the filesystem.
const makePausedWriteFileSystem = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const firstWrite = yield* Ref.make(true);
  const paused = yield* Deferred.make<string>();
  const resume = yield* Deferred.make<void>();
  const controlled = {
    ...fileSystem,
    writeFile: (filePath, bytes, options) =>
      Effect.gen(function* () {
        if (!(yield* Ref.getAndSet(firstWrite, false)))
          return yield* fileSystem.writeFile(filePath, bytes, options);
        yield* fileSystem.writeFile(
          filePath,
          bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2))),
          options,
        );
        yield* Deferred.succeed(paused, String(filePath));
        yield* Deferred.await(resume);
        yield* fileSystem.writeFile(filePath, bytes, options);
      }),
    open: (filePath, options) =>
      fileSystem.open(filePath, options).pipe(
        Effect.map((file) => {
          const writeAll = file.writeAll.bind(file);
          return Object.assign(file, {
            writeAll: (bytes: Uint8Array) =>
              Effect.gen(function* () {
                if (!(yield* Ref.getAndSet(firstWrite, false))) return yield* writeAll(bytes);
                const split = Math.max(1, Math.floor(bytes.length / 2));
                yield* writeAll(bytes.subarray(0, split));
                yield* Deferred.succeed(paused, String(filePath));
                yield* Deferred.await(resume);
                yield* writeAll(bytes.subarray(split));
              }),
          });
        }),
      ),
  } satisfies FileSystem.FileSystem;
  return { fileSystem: controlled, paused, resume };
});

it.layer(NodeServices.layer)("ServerSecretStore.layer", (it) => {
  it.effect("returns Option.none when a secret file does not exist", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const secret = yield* secretStore.get("missing-secret");

      assert.isTrue(Option.isNone(secret));
    }).pipe(Effect.provide(makeServerSecretStoreLayer())),
  );

  it.effect("reuses an existing secret instead of regenerating it", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const first = yield* secretStore.getOrCreateRandom("session-signing-key", 32);
      const second = yield* secretStore.getOrCreateRandom("session-signing-key", 32);

      assert.deepEqual(Array.from(second), Array.from(first));
    }).pipe(Effect.provide(makeServerSecretStoreLayer())),
  );

  it.effect("returns the persisted secret when concurrent creators race", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const [first, second] = yield* Effect.all(
        [
          secretStore.getOrCreateRandom("session-signing-key", 32),
          secretStore.getOrCreateRandom("session-signing-key", 32),
        ],
        { concurrency: "unbounded" },
      );
      const persisted = yield* secretStore.get("session-signing-key");
      const persistedBytes = Option.getOrThrow(persisted);

      assert.deepEqual(Array.from(first), Array.from(persistedBytes));
      assert.deepEqual(Array.from(second), Array.from(persistedBytes));
    }).pipe(Effect.provide(makeConcurrentCreateSecretStoreLayer())),
  );

  it.effect("publishes only complete private keys when another creator reads during a write", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const controlled = yield* makePausedWriteFileSystem;
      const secretStore = yield* ServerSecretStore.make.pipe(
        Effect.provideService(FileSystem.FileSystem, controlled.fileSystem),
      );
      const first = yield* secretStore
        .getOrCreateRandom("session-signing-key", 32)
        .pipe(Effect.forkScoped({ startImmediately: true }));
      const candidatePath = yield* Deferred.await(controlled.paused);
      const candidate = yield* fileSystem.stat(candidatePath);
      const directory = yield* fileSystem.stat(config.secretsDir);
      const candidateDirectory = yield* fileSystem.stat(path.dirname(candidatePath));
      const beforePublication = yield* secretStore.get("session-signing-key");
      const second = yield* secretStore.getOrCreateRandom("session-signing-key", 32);
      yield* Deferred.succeed(controlled.resume, void 0);
      const firstBytes = yield* Fiber.join(first);
      const persisted = Option.getOrThrow(yield* secretStore.get("session-signing-key"));
      const published = yield* fileSystem.stat(
        path.join(config.secretsDir, "session-signing-key.bin"),
      );

      assert.equal(Number(candidate.size), 16);
      if ((yield* HostProcessPlatform) !== "win32") {
        assert.equal(directory.mode & 0o777, 0o700);
        assert.equal(candidateDirectory.mode & 0o777, 0o700);
        assert.equal(candidate.mode & 0o777, 0o600);
        assert.equal(published.mode & 0o777, 0o600);
      }
      assert.isTrue(Option.isNone(beforePublication));
      assert.equal(second.length, 32);
      assert.equal(persisted.length, 32);
      assert.deepEqual(Array.from(firstBytes), Array.from(persisted));
      assert.deepEqual(Array.from(second), Array.from(persisted));
      assert.deepEqual(yield* fileSystem.readDirectory(config.secretsDir), [
        "session-signing-key.bin",
      ]);
    }).pipe(Effect.provide(makeServerConfigLayer()), Effect.scoped),
  );

  it.effect("create never replaces or removes an existing secret", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const secretStore = yield* ServerSecretStore.make;
      const original = new TextEncoder().encode("synthetic-original-proof");
      yield* secretStore.create("dpop-proof-fixture", original);
      const error = yield* Effect.flip(
        secretStore.create(
          "dpop-proof-fixture",
          new TextEncoder().encode("synthetic-replacement-proof"),
        ),
      );

      assert.isTrue(ServerSecretStore.isSecretAlreadyExistsError(error));
      assert.deepEqual(
        Array.from(Option.getOrThrow(yield* secretStore.get("dpop-proof-fixture"))),
        Array.from(original),
      );
      assert.deepEqual(yield* fileSystem.readDirectory(config.secretsDir), [
        "dpop-proof-fixture.bin",
      ]);
    }).pipe(Effect.provide(makeServerConfigLayer())),
  );

  for (const operation of ["create", "set"] as const) {
    it.effect(`${operation} removes only its private candidate when interrupted mid-write`, () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig.ServerConfig;
        const controlled = yield* makePausedWriteFileSystem;
        const secretStore = yield* ServerSecretStore.make.pipe(
          Effect.provideService(FileSystem.FileSystem, controlled.fileSystem),
        );
        const original = new TextEncoder().encode("synthetic-old-provider-key");
        if (operation === "set") {
          yield* fileSystem.writeFile(path.join(config.secretsDir, "provider-key.bin"), original, {
            mode: 0o600,
          });
        }
        const write = yield* secretStore[operation](
          "provider-key",
          new TextEncoder().encode("synthetic-new-provider-key"),
        ).pipe(Effect.forkScoped({ startImmediately: true }));
        const candidatePath = yield* Deferred.await(controlled.paused);
        assert.isTrue(yield* fileSystem.exists(candidatePath));
        yield* Fiber.interrupt(write);

        assert.isFalse(yield* fileSystem.exists(candidatePath));
        const saved = yield* secretStore.get("provider-key");
        if (operation === "set") {
          assert.deepEqual(Array.from(Option.getOrThrow(saved)), Array.from(original));
          assert.deepEqual(yield* fileSystem.readDirectory(config.secretsDir), [
            "provider-key.bin",
          ]);
        } else {
          assert.isTrue(Option.isNone(saved));
          assert.deepEqual(yield* fileSystem.readDirectory(config.secretsDir), []);
        }
      }).pipe(Effect.provide(makeServerConfigLayer()), Effect.scoped),
    );

    it.effect(
      `${operation} preserves the previous state and removes its candidate on sync failure`,
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const config = yield* ServerConfig.ServerConfig;
          const failingFileSystem = {
            ...fileSystem,
            open: (filePath, options) =>
              fileSystem.open(filePath, options).pipe(
                Effect.map((file) => {
                  Object.defineProperty(file, "sync", {
                    value: Effect.fail(
                      PlatformError.systemError({
                        _tag: "PermissionDenied",
                        module: "FileSystem",
                        method: "sync",
                        pathOrDescriptor: String(filePath),
                        description: "Synthetic sync failure.",
                      }),
                    ),
                  });
                  return file;
                }),
              ),
          } satisfies FileSystem.FileSystem;
          const secretStore = yield* ServerSecretStore.make.pipe(
            Effect.provideService(FileSystem.FileSystem, failingFileSystem),
          );
          const original = new TextEncoder().encode("synthetic-old-provider-key");
          if (operation === "set") {
            yield* fileSystem.writeFile(
              path.join(config.secretsDir, "provider-key.bin"),
              original,
              { mode: 0o600 },
            );
          }
          const error = yield* Effect.flip(
            secretStore[operation](
              "provider-key",
              new TextEncoder().encode("synthetic-new-provider-key"),
            ),
          );
          assert.instanceOf(error, ServerSecretStore.SecretStorePersistError);
          const saved = yield* secretStore.get("provider-key");
          if (operation === "set") {
            assert.deepEqual(Array.from(Option.getOrThrow(saved)), Array.from(original));
            assert.deepEqual(yield* fileSystem.readDirectory(config.secretsDir), [
              "provider-key.bin",
            ]);
          } else {
            assert.isTrue(Option.isNone(saved));
            assert.deepEqual(yield* fileSystem.readDirectory(config.secretsDir), []);
          }
        }).pipe(Effect.provide(makeServerConfigLayer())),
    );
  }

  it.effect("propagates read failures other than missing-file errors", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const error = yield* Effect.flip(secretStore.getOrCreateRandom("session-signing-key", 32));

      assert.instanceOf(error, ServerSecretStore.SecretStoreReadError);
      assert.include(error.message, "Failed to read secret session-signing-key.");
      assert.instanceOf(error.cause, PlatformError.PlatformError);
      assert.equal((error.cause as PlatformError.PlatformError).reason._tag, "PermissionDenied");
    }).pipe(Effect.provide(makePermissionDeniedSecretStoreLayer())),
  );

  it.effect("propagates write failures instead of treating them as success", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const error = yield* Effect.flip(
        secretStore.set("session-signing-key", Uint8Array.from([1, 2, 3])),
      );

      assert.instanceOf(error, ServerSecretStore.SecretStorePersistError);
      assert.include(error.message, "Failed to persist secret session-signing-key.");
      assert.instanceOf(error.cause, PlatformError.PlatformError);
      assert.equal((error.cause as PlatformError.PlatformError).reason._tag, "PermissionDenied");
    }).pipe(Effect.provide(makeRenameFailureSecretStoreLayer())),
  );

  it.effect("propagates remove failures other than missing-file errors", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const error = yield* Effect.flip(secretStore.remove("session-signing-key"));

      assert.instanceOf(error, ServerSecretStore.SecretStoreRemoveError);
      assert.include(error.message, "Failed to remove secret session-signing-key.");
      assert.instanceOf(error.cause, PlatformError.PlatformError);
      assert.equal((error.cause as PlatformError.PlatformError).reason._tag, "PermissionDenied");
    }).pipe(Effect.provide(makeRemoveFailureSecretStoreLayer())),
  );
});
