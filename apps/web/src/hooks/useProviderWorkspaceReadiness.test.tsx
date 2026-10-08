import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";

const state = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("../state/server", () => ({ serverEnvironment: { refreshProviders: "refresh" } }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => state.refresh }));
import { useProviderWorkspaceReadiness } from "./useProviderWorkspaceReadiness";

const environmentId = EnvironmentId.make("remote");
const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("native"),
  driver: ProviderDriverKind.make("meerkat"),
  installed: true,
  enabled: true,
  version: null,
  status: "warning",
  auth: { status: "unauthenticated" },
  checkedAt: "2026-10-04T00:00:00.000Z",
  models: [],
  skills: [],
  slashCommands: [],
  supportsWorkspaceReadiness: true,
};
function scoped(cwd: string): ServerProvider {
  return {
    ...provider,
    workspaceSnapshots: [
      {
        cwd,
        checkedAt: provider.checkedAt,
        skills: [],
        slashCommands: [],
        readiness: {
          status: "ready",
          auth: { status: "authenticated" },
          models: [
            {
              slug: "openai:example",
              name: cwd,
              isCustom: false,
              capabilities: null,
              credentialState: "connected",
            },
          ],
        },
      },
    ],
  };
}
function Harness({
  cwd,
  providers,
  environment = environmentId,
}: {
  cwd: string;
  providers: ServerProvider[];
  environment?: EnvironmentId;
}) {
  const workspace = useProviderWorkspaceReadiness({ environmentId: environment, cwd, providers });
  return (
    <output data-pending={workspace.pendingInstanceIds.size}>
      {workspace.providers.flatMap((entry) => entry.models.map((model) => model.name)).join(",")}
    </output>
  );
}
let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.refresh.mockReset().mockResolvedValue({ _tag: "Success", value: { providers: [] } });
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("checks exact remote workspace once and rechecks after account invalidation removes its row", async () => {
  state.refresh.mockResolvedValue({ _tag: "Success", value: { providers: [scoped("/b")] } });
  await act(async () => {
    renderer = create(<Harness cwd="/b" providers={[provider]} />);
  });
  expect(state.refresh).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { instanceId: provider.instanceId, cwd: "/b" },
  });
  await act(async () => renderer!.update(<Harness cwd="/b" providers={[scoped("/b")]} />));
  expect(renderer!.root.findByType("output").children).toEqual(["/b"]);
  await act(async () =>
    renderer!.update(
      <Harness cwd="/b" providers={[{ ...scoped("/b"), message: "Other status changed" }]} />,
    ),
  );
  expect(state.refresh).toHaveBeenCalledOnce();
  await act(async () =>
    renderer!.update(<Harness cwd="/b" providers={[{ ...provider, workspaceSnapshots: [] }]} />),
  );
  expect(state.refresh).toHaveBeenCalledTimes(2);
});

it("does not reuse an in-flight result after switching cwd or environment", async () => {
  let finishA!: (value: unknown) => void;
  state.refresh.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishA = resolve;
      }),
  );
  await act(async () => {
    renderer = create(<Harness cwd="/a" providers={[provider]} />);
  });
  await act(async () => renderer!.update(<Harness cwd="/b" providers={[provider]} />));
  await act(async () => {
    finishA({ _tag: "Success", value: { providers: [scoped("/a")] } });
  });
  expect(renderer!.root.findByType("output").children).toEqual([]);
  const otherEnvironment = EnvironmentId.make("other");
  await act(async () =>
    renderer!.update(<Harness cwd="/b" providers={[provider]} environment={otherEnvironment} />),
  );
  expect(
    state.refresh.mock.calls.map(([request]) => [request.environmentId, request.input.cwd]),
  ).toEqual([
    [environmentId, "/a"],
    [environmentId, "/b"],
    [otherEnvironment, "/b"],
  ]);
});

it("bounds missing-result retries and stops polling when the server publishes an explicit error", async () => {
  vi.useFakeTimers();
  await act(async () => {
    renderer = create(<Harness cwd="/b" providers={[provider]} />);
  });
  await act(async () =>
    renderer!.update(
      <Harness cwd="/b" providers={[{ ...provider, message: "Unrelated update" }]} />,
    ),
  );
  expect(state.refresh).toHaveBeenCalledOnce();
  await act(async () => {
    vi.advanceTimersByTime(4_999);
  });
  expect(state.refresh).toHaveBeenCalledOnce();
  await act(async () => {
    vi.advanceTimersByTime(1);
  });
  expect(state.refresh).toHaveBeenCalledTimes(2);
  const failed: ServerProvider = {
    ...scoped("/b"),
    workspaceSnapshots: [
      {
        ...scoped("/b").workspaceSnapshots![0]!,
        readiness: { status: "error", auth: { status: "unknown" }, models: [] },
      },
    ],
  };
  await act(async () => renderer!.update(<Harness cwd="/b" providers={[failed]} />));
  await act(async () => {
    vi.advanceTimersByTime(30_000);
  });
  expect(state.refresh).toHaveBeenCalledTimes(2);
});

it("does not probe legacy servers or other drivers", async () => {
  await act(async () => {
    renderer = create(
      <Harness
        cwd="/b"
        providers={[
          { ...provider, supportsWorkspaceReadiness: false },
          {
            ...provider,
            instanceId: ProviderInstanceId.make("codex"),
            driver: ProviderDriverKind.make("codex"),
          },
        ]}
      />,
    );
  });
  expect(state.refresh).not.toHaveBeenCalled();
});

it.each([
  { installed: false, status: "error" },
  { enabled: false },
  { status: "disabled" },
  { availability: "unavailable" },
] satisfies Partial<ServerProvider>[])(
  "starts a scoped check only after machine eligibility returns from %j",
  async (overrides) => {
    vi.useFakeTimers();
    const unavailable = { ...provider, ...overrides };
    await act(async () => {
      renderer = create(<Harness cwd="/b" providers={[unavailable]} />);
    });
    expect(renderer!.root.findByType("output").props["data-pending"]).toBe(0);
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(state.refresh).not.toHaveBeenCalled();
    await act(async () => renderer!.update(<Harness cwd="/b" providers={[provider]} />));
    expect(state.refresh).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { instanceId: provider.instanceId, cwd: "/b" },
    });
    expect(renderer!.root.findByType("output").props["data-pending"]).toBe(1);
    await act(async () => renderer!.update(<Harness cwd="/b" providers={[unavailable]} />));
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(state.refresh).toHaveBeenCalledOnce();
    expect(renderer!.root.findByType("output").props["data-pending"]).toBe(0);
  },
);
