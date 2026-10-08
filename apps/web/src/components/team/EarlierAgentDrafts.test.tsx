import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";

const { reconcile, clipboard } = vi.hoisted(() => ({ reconcile: vi.fn(), clipboard: vi.fn() }));
vi.mock("./NativeAgentImages", () => ({
  NativeAgentImages: () => null,
}));
vi.mock("../../state/meerkatTeam", () => ({
  meerkatTeamEnvironment: { agentDeliveryReconcile: "receipt-only" },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => {
    if (command !== "receipt-only") throw new Error("Unexpected command in saved draft recovery");
    return reconcile;
  },
}));
vi.mock("../../state/query", () => ({
  formatEnvironmentQueryError: () => "Receipt lookup failed",
}));
vi.mock("../../hooks/useCopyToClipboard", () => ({ writeTextToClipboard: clipboard }));
vi.mock("../ui/button", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => (
    <button {...props} />
  ),
}));
vi.mock("../ui/dialog", () => {
  const Content = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
      open ? <div role="dialog">{children}</div> : null,
    DialogPopup: Content,
    DialogHeader: Content,
    DialogTitle: Content,
    DialogDescription: Content,
    DialogPanel: Content,
    DialogFooter: Content,
    DialogClose: Content,
  };
});

import { EarlierAgentDrafts } from "./EarlierAgentDrafts";

const scope = {
  environmentId: EnvironmentId.make("env"),
  projectId: ProjectId.make("project"),
  instanceId: ProviderInstanceId.make("meerkat"),
};
const key = JSON.stringify([
  scope.environmentId,
  scope.projectId,
  scope.instanceId,
  "mob",
  "reviewer",
]);
const attempt = {
  requestId: "old-request",
  agentRef: "old-session",
  text: "Review this",
  mode: "steer",
};
const storage = () => {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    key: (index: number) => [...entries.keys()][index] ?? null,
    getItem: (name: string) => entries.get(name) ?? null,
    setItem: (name: string, value: string) => {
      entries.set(name, value);
    },
    removeItem: (name: string) => {
      entries.delete(name);
    },
    snapshot: () => [...entries],
  };
};
let renderer: ReactTestRenderer | undefined;
let saved: ReturnType<typeof storage>;

function button(label: string) {
  return renderer!.root.findAllByType("button").find((entry) =>
    entry.children
      .filter((child) => typeof child === "string")
      .join("")
      .includes(label),
  )!;
}
function mountAndOpen() {
  act(() => {
    renderer = create(<EarlierAgentDrafts {...scope} />);
  });
  act(() => button("Earlier saved drafts").props.onClick());
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  saved = storage();
  saved.setItem(
    "t3code:meerkat-agent-drafts:v1",
    JSON.stringify({ [key]: { text: "Changed draft", mode: "queue", attempts: [attempt] } }),
  );
  saved.setItem(
    "t3code:meerkat-unsent-queue:v1",
    JSON.stringify({ [key]: [{ id: "old-queue", text: "Waiting", sendWhenIdle: true }] }),
  );
  vi.stubGlobal("localStorage", saved);
  vi.stubGlobal("sessionStorage", storage());
  reconcile.mockReset();
  clipboard.mockReset();
  clipboard.mockResolvedValue(true);
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("earlier agent draft recovery UI", () => {
  it.each([null, { status: "accepted" }, { status: "uncertain", message: "Receipt pending" }])(
    "only checks the original receipt and retains all saved data (%o)",
    async (receipt) => {
      reconcile.mockResolvedValue({ _tag: "Success", value: receipt });
      const before = saved.snapshot();
      mountAndOpen();
      expect(reconcile).not.toHaveBeenCalled();
      expect(saved.snapshot()).toEqual(before);
      await act(async () => {
        await button("Check delivery").props.onClick();
      });
      expect(reconcile).toHaveBeenCalledExactlyOnceWith({
        environmentId: scope.environmentId,
        input: {
          projectId: scope.projectId,
          instanceId: scope.instanceId,
          agentRef: "old-session",
          requestId: "old-request",
          text: "Review this",
          handlingMode: "steer",
        },
      });
      expect(saved.snapshot()).toEqual(before);
      expect(button("Check delivery")).toBeDefined();
      expect(
        renderer!.root
          .findAllByType("button")
          .some((entry) => String(entry.props.children).includes("Retry")),
      ).toBe(false);
    },
  );

  it("does not check a removed request from an already open recovery dialog", async () => {
    mountAndOpen();
    saved.setItem(
      "t3code:meerkat-agent-drafts:v1",
      JSON.stringify({ [key]: { text: "Keep", mode: "queue", attempts: [] } }),
    );
    await act(async () => {
      await button("Check delivery").props.onClick();
    });
    expect(reconcile).not.toHaveBeenCalled();
    expect(JSON.stringify(renderer!.toJSON())).toContain(
      "original request or its saved agent session is unavailable",
    );
  });

  it("copies text without changing the stored draft or sending it", async () => {
    const before = saved.snapshot();
    mountAndOpen();
    await act(async () => {
      await button("Copy text").props.onClick();
    });
    expect(clipboard).toHaveBeenCalledExactlyOnceWith("Changed draft");
    expect(reconcile).not.toHaveBeenCalled();
    expect(saved.snapshot()).toEqual(before);
  });
});
