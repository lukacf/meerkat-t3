import { assert, describe, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { beforeEach, vi } from "vite-plus/test";

const {
  appendSwitchMock,
  getSwitchValueMock,
  hasSwitchMock,
  registerSchemesMock,
  setDesktopNameMock,
  mkdirSyncMock,
  writeFileSyncMock,
  setPathMock,
} = vi.hoisted(() => ({
  appendSwitchMock: vi.fn(),
  getSwitchValueMock: vi.fn(),
  hasSwitchMock: vi.fn(),
  registerSchemesMock: vi.fn(),
  setDesktopNameMock: vi.fn(),
  mkdirSyncMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
  setPathMock: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    setPath: setPathMock,
    setDesktopName: setDesktopNameMock,
    getVersion: () => "0.0.37",
    commandLine: {
      appendSwitch: appendSwitchMock,
      getSwitchValue: getSwitchValueMock,
      hasSwitch: hasSwitchMock,
    },
  },
  protocol: {
    registerSchemesAsPrivileged: registerSchemesMock,
  },
}));

vi.mock("node:fs", () => ({
  readFileSync: () => "{}",
  mkdirSync: mkdirSyncMock,
  writeFileSync: writeFileSyncMock,
}));

import * as DesktopPreReadyPlatform from "./DesktopPreReadyPlatform.ts";
import * as DesktopConfig from "./DesktopConfig.ts";

describe("DesktopPreReadyPlatform", () => {
  beforeEach(() => {
    appendSwitchMock.mockReset();
    getSwitchValueMock.mockReset();
    hasSwitchMock.mockReset();
    registerSchemesMock.mockReset();
    setDesktopNameMock.mockReset();
    mkdirSyncMock.mockReset();
    writeFileSyncMock.mockReset();
    setPathMock.mockReset();
  });

  it.effect("prepares and selects the isolated profile before the next event-loop turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events: string[] = [];
        mkdirSyncMock.mockImplementation(() => events.push("mkdir"));
        appendSwitchMock.mockImplementation((name) => events.push(`switch:${name}`));
        setPathMock.mockImplementation((name) => events.push(`path:${name}`));
        const nextTurn = Promise.resolve().then(() => [...events]);
        const options = yield* DesktopPreReadyPlatform.make.pipe(
          Effect.provideService(HostProcessPlatform, "darwin"),
          Effect.provide(
            DesktopConfig.layerTest({ T3CODE_DESKTOP_USER_DATA_DIR: " /tmp/isolated-profile " }),
          ),
        );

        assert.equal(options.userDataPath, "/tmp/isolated-profile");
        assert.deepEqual(mkdirSyncMock.mock.calls, [["/tmp/isolated-profile", { recursive: true }]]);
        assert.deepEqual(appendSwitchMock.mock.calls, [["user-data-dir", "/tmp/isolated-profile"]]);
        assert.deepEqual(setPathMock.mock.calls, [["userData", "/tmp/isolated-profile"]]);
        assert.deepEqual(yield* Effect.promise(() => nextTurn), [
          "mkdir",
          "switch:user-data-dir",
          "path:userData",
        ]);
      }),
    ),
  );

  it.effect("does not touch an Electron profile when preparing the override fails", () => {
    const cause = new Error("profile unavailable");
    mkdirSyncMock.mockImplementation(() => {
      throw cause;
    });
    return DesktopPreReadyPlatform.make.pipe(
      Effect.provideService(HostProcessPlatform, "darwin"),
      Effect.provide(DesktopConfig.layerTest({ T3CODE_DESKTOP_USER_DATA_DIR: "/tmp/blocked" })),
      Effect.exit,
      Effect.map((exit) => {
        assert.isTrue(exit._tag === "Failure");
        assert.equal(setPathMock.mock.calls.length, 0);
        assert.equal(appendSwitchMock.mock.calls.length, 0);
      }),
    );
  });

  it.effect("preserves an explicit Linux password-store switch", () => {
    hasSwitchMock.mockImplementation((switchName) => switchName === "password-store");
    getSwitchValueMock.mockReturnValue(" basic ");

    return Effect.gen(function* () {
      const options = yield* DesktopPreReadyPlatform.DesktopPreReadyElectronOptions;

      assert.equal(options.linuxPasswordStoreCommandLine, "basic");
      assert.isFalse(appendSwitchMock.mock.calls.some(([name]) => name === "password-store"));
    }).pipe(
      Effect.provide(
        DesktopPreReadyPlatform.layer.pipe(
          Layer.provide(Layer.succeed(HostProcessPlatform, "linux")),
        ),
      ),
    );
  });

  for (const previousEntry of [undefined, 'Exec="/Applications/deleted-previous.AppImage" %U']) {
    it.effect(
      `prepares a ${previousEntry ? "stale" : "missing"} Linux desktop entry before startup yields`,
      () => {
        vi.stubEnv("VITE_DEV_SERVER_URL", "");
        vi.stubEnv("XDG_DATA_HOME", "/xdg");
        vi.stubEnv("APPIMAGE", "/Applications/current.AppImage");
        getSwitchValueMock.mockReturnValue("");
        let desktopName = "t3code.desktop";
        let desktopEntry = previousEntry;
        setDesktopNameMock.mockImplementation((name: string) => {
          desktopName = name;
        });
        writeFileSyncMock.mockImplementation((path: string, contents: string) => {
          if (path === "/xdg/applications/ai.rkat.MeerkatT3.desktop") desktopEntry = contents;
        });

        return Effect.scoped(
          Effect.gen(function* () {
            const portalIdentity = Promise.resolve().then(() => ({ desktopName, desktopEntry }));
            yield* Layer.build(
              DesktopPreReadyPlatform.layer.pipe(
                Layer.provide(Layer.succeed(HostProcessPlatform, "linux")),
              ),
            );
            const identity = yield* Effect.promise(() => portalIdentity);
            assert.equal(identity.desktopName, "ai.rkat.MeerkatT3.desktop");
            assert.include(identity.desktopEntry ?? "", 'Exec="/Applications/current.AppImage" %U');
            assert.include(identity.desktopEntry ?? "", "Name=Meerkat T3 (Prototype)");
            assert.include(identity.desktopEntry ?? "", "MimeType=x-scheme-handler/meerkat-t3;");
          }),
        ).pipe(Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())));
      },
    );
  }

  it.effect("keeps startup available when the early desktop entry cannot be written", () => {
    getSwitchValueMock.mockReturnValue("");
    mkdirSyncMock.mockImplementation(() => {
      throw new Error("read-only filesystem");
    });

    return DesktopPreReadyPlatform.make.pipe(
      Effect.provideService(HostProcessPlatform, "linux"),
      Effect.asVoid,
    );
  });

  it.effect(
    "acquires a synchronous pre-ready layer before an asynchronous Clerk-shaped layer",
    () =>
      Effect.gen(function* () {
        class ClerkShaped extends Context.Service<ClerkShaped, { readonly ready: true }>()(
          "@t3tools/desktop/app/DesktopPreReadyPlatform.test/ClerkShaped",
        ) {}

        const events: Array<string> = [];
        registerSchemesMock.mockImplementation(() => {
          events.push("pre-ready");
        });

        const preReadyLayer = DesktopPreReadyPlatform.layer.pipe(
          Layer.provide(Layer.succeed(HostProcessPlatform, "darwin")),
        );

        const clerkShapedLayer = Layer.effect(
          ClerkShaped,
          Effect.promise(() => Promise.resolve()).pipe(
            Effect.map(() => {
              events.push("clerk");
              return { ready: true as const };
            }),
          ),
        );

        const runtimeLayer = clerkShapedLayer.pipe(
          Layer.flatMap((clerkContext) => Layer.succeedContext(clerkContext)),
          Layer.provideMerge(preReadyLayer),
        );

        const result = yield* Effect.all({
          clerk: ClerkShaped,
          preReady: DesktopPreReadyPlatform.DesktopPreReadyElectronOptions,
        }).pipe(Effect.provide(runtimeLayer));

        assert.deepEqual(result, {
          clerk: { ready: true },
          preReady: {
            linux: null,
            linuxPasswordStoreCommandLine: null,
            userDataPath: result.preReady.userDataPath,
          },
        });
        assert.deepEqual(events, ["pre-ready", "clerk"]);
        assert.equal(registerSchemesMock.mock.calls.length, 1);
        assert.equal(appendSwitchMock.mock.calls.length, 0);
        assert.equal(setDesktopNameMock.mock.calls.length, 0);
      }),
  );
});
