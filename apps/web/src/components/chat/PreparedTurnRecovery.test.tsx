import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  MessageId,
  type ThreadPreparedTurn,
} from "@t3tools/contracts";
import { act, type ComponentProps } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
vi.mock("../ui/button", () => ({ Button: "button" }));
import { PreparedTurnRecovery, preparedTurnBlocksSend } from "./PreparedTurnRecovery";

const recovery: ThreadPreparedTurn = {
  recoveryId: CommandId.make("original-command"),
  projectId: ProjectId.make("project"),
  projectCwd: "/project",
  providerIdentity: {
    driverKind: ProviderDriverKind.make("meerkat"),
    continuationKey: "fixture-meerkat",
  },
  expectedCwd: "/checkout/original",
  phase: "blocked",
  setup: "finished",
  reason: "Connect a model account",
  createdAt: "2026-10-04T12:00:00.000Z",
  updatedAt: "2026-10-04T12:01:00.000Z",
  command: {
    type: "thread.turn.start",
    commandId: CommandId.make("original-command"),
    threadId: ThreadId.make("thread"),
    message: {
      messageId: MessageId.make("message"),
      role: "user",
      text: "Original message",
      attachments: [],
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: "2026-10-04T12:00:00.000Z",
  },
};
let renderer: ReactTestRenderer | undefined;
const button = (name: string) =>
  renderer!.root.findAllByType("button").find((entry) => entry.children.includes(name))!;
const props = (
  overrides: Partial<ComponentProps<typeof PreparedTurnRecovery>> = {},
): ComponentProps<typeof PreparedTurnRecovery> => ({
  prepared: recovery,
  disabledReason: null,
  setupActive: false,
  hasDraft: false,
  onAccounts: vi.fn(),
  onRetry: vi.fn().mockResolvedValue(undefined),
  onEdit: vi.fn().mockResolvedValue(undefined),
  ...overrides,
});
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("prepared message recovery", () => {
  it("mounts and remounts retained work without retrying or editing", async () => {
    const input = props();
    await act(async () => {
      renderer = create(<PreparedTurnRecovery {...input} />);
    });
    await act(async () => renderer!.unmount());
    await act(async () => {
      renderer = create(<PreparedTurnRecovery {...input} />);
    });
    expect(input.onRetry).not.toHaveBeenCalled();
    expect(input.onEdit).not.toHaveBeenCalled();
    await act(async () => button("Retry saved message").props.onClick());
    expect(input.onRetry).toHaveBeenCalledExactlyOnceWith(false);
  });
  it("requires explicit acknowledgement of interrupted setup and retains it only in this mounted recovery", async () => {
    const input = props({ prepared: { ...recovery, setup: "sync_running" } });
    await act(async () => {
      renderer = create(<PreparedTurnRecovery {...input} />);
    });
    await act(async () => button("Retry saved message").props.onClick());
    expect(input.onRetry).not.toHaveBeenCalled();
    await act(async () =>
      renderer!.root.findByType("input").props.onChange({ target: { checked: true } }),
    );
    await act(async () => button("Retry saved message").props.onClick());
    expect(input.onRetry).toHaveBeenCalledExactlyOnceWith(true);
    await act(async () => renderer!.unmount());
    await act(async () => {
      renderer = create(<PreparedTurnRecovery {...input} />);
    });
    expect(renderer!.root.findByType("input").props.checked).toBe(false);
  });
  it("excludes duplicate operations synchronously while a response is pending", async () => {
    let done!: () => void;
    const wait = new Promise<void>((resolve) => {
      done = resolve;
    });
    const input = props({ onRetry: vi.fn(() => wait) });
    await act(async () => {
      renderer = create(<PreparedTurnRecovery {...input} />);
    });
    const click = button("Retry saved message").props.onClick;
    await act(async () => {
      click();
      click();
    });
    expect(input.onRetry).toHaveBeenCalledTimes(1);
    await act(async () => done());
  });
  it("rejects captured callbacks after scope unmount and after a live safety block", async () => {
    const input = props();
    await act(async () => {
      renderer = create(<PreparedTurnRecovery {...input} />);
    });
    const click = button("Retry saved message").props.onClick;
    await act(async () =>
      renderer!.update(
        <PreparedTurnRecovery {...input} disabledReason="Review restored profile first" />,
      ),
    );
    await act(async () => click());
    expect(input.onRetry).not.toHaveBeenCalled();
    await act(async () => renderer!.unmount());
    await act(async () => click());
    expect(input.onRetry).not.toHaveBeenCalled();
  });
  it("blocks fresh sends for all unreleased phases and never retries a released tombstone", async () => {
    for (const phase of ["preparing", "ready", "blocked"] as const)
      expect(preparedTurnBlocksSend({ ...recovery, phase })).toBe(true);
    expect(preparedTurnBlocksSend({ ...recovery, phase: "released" })).toBe(false);
    expect(preparedTurnBlocksSend(null)).toBe(false);
    const input = props();
    await act(async () => {
      renderer = create(<PreparedTurnRecovery {...input} />);
    });
    const click = button("Retry saved message").props.onClick;
    await act(async () =>
      renderer!.update(
        <PreparedTurnRecovery {...input} prepared={{ ...recovery, phase: "released" }} />,
      ),
    );
    await act(async () => click());
    expect(input.onRetry).not.toHaveBeenCalled();
    await act(async () => button("Restore saved message").props.onClick());
    expect(input.onEdit).toHaveBeenCalledTimes(1);
  });
  it("keeps failures visible without retrying automatically and protects an existing draft", async () => {
    const input = props({
      onEdit: vi.fn().mockRejectedValue(new Error("Draft could not be saved")),
    });
    await act(async () => {
      renderer = create(<PreparedTurnRecovery {...input} />);
    });
    const edit = button("Edit message").props.onClick;
    await act(async () => edit());
    expect(renderer!.root.findByProps({ role: "alert" }).children).toContain(
      "Draft could not be saved",
    );
    await act(async () => renderer!.update(<PreparedTurnRecovery {...input} hasDraft />));
    await act(async () => edit());
    expect(input.onEdit).toHaveBeenCalledTimes(1);
  });
  it("does not retry or release a checkout while preparation owns it", async () => {
    const input = props({ setupActive: true, prepared: { ...recovery, phase: "preparing" } });
    await act(async () => {
      renderer = create(<PreparedTurnRecovery {...input} />);
    });
    await act(async () => {
      button("Retry saved message").props.onClick();
      button("Edit message").props.onClick();
    });
    expect(input.onRetry).not.toHaveBeenCalled();
    expect(input.onEdit).not.toHaveBeenCalled();
    await act(async () =>
      renderer!.update(
        <PreparedTurnRecovery
          {...input}
          setupActive={false}
          prepared={{ ...recovery, phase: "ready" }}
        />,
      ),
    );
    await act(async () => {
      button("Retry saved message").props.onClick();
      button("Edit message").props.onClick();
    });
    expect(input.onRetry).not.toHaveBeenCalled();
    expect(input.onEdit).not.toHaveBeenCalled();
  });
  it("allows the existing async setup overlap and known setup failure without an interruption acknowledgement", async () => {
    const input = props({ setupActive: true, prepared: { ...recovery, setup: "async_running" } });
    await act(async () => {
      renderer = create(<PreparedTurnRecovery {...input} />);
    });
    await act(async () => button("Retry saved message").props.onClick());
    expect(input.onRetry).toHaveBeenCalledExactlyOnceWith(false);
    await act(async () => button("Edit message").props.onClick());
    expect(input.onEdit).not.toHaveBeenCalled();
    await act(async () =>
      renderer!.update(
        <PreparedTurnRecovery
          {...input}
          setupActive={false}
          prepared={{ ...recovery, setup: "failed" }}
        />,
      ),
    );
    await act(async () => button("Retry saved message").props.onClick());
    expect(input.onRetry).toHaveBeenCalledTimes(2);
    expect(renderer!.root.findAllByType("input")).toHaveLength(0);
  });
});
