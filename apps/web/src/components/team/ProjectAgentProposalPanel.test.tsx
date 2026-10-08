import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type MeerkatProjectAgent,
  type MeerkatProjectAgentProposal,
  type MeerkatProjectProposal,
  type MeerkatProjectTeam,
} from "@t3tools/contracts";
import { act, type PropsWithChildren } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  proposal: null as MeerkatProjectProposal | null,
  team: null as MeerkatProjectTeam | null,
  teamError: null as string | null,
  create: vi.fn(),
  prepare: vi.fn(),
  startTurn: vi.fn(),
  refresh: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
vi.mock("../../lib/utils", () => ({ newMessageId: () => "message" }));
vi.mock("../../state/meerkatTeam", () => ({
  meerkatTeamEnvironment: {
    projectProposal: () => "proposal",
    projectTeam: () => "team",
    projectProposalCreate: "create",
    projectAgentPrepare: "prepare",
  },
  useVisibleTeamRefresh: () => {},
}));
vi.mock("../../state/threads", () => ({ threadEnvironment: { startTurn: "startTurn" } }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (query: string) => ({
    data: query === "proposal" ? state.proposal : state.team,
    error: query === "team" ? state.teamError : null,
    isPending: false,
    refresh: state.refresh,
  }),
  formatEnvironmentQueryError: (cause: unknown) => String(cause),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: "create" | "prepare" | "startTurn") => state[command],
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/badge", () => ({ Badge: "span" }));
vi.mock("../ui/checkbox", () => ({ Checkbox: "input" }));
vi.mock("./ProjectAgentPermissions", () => ({
  ProjectAgentPermissions: ({
    value,
    onChange,
    disabled,
  }: {
    value: string;
    onChange: (value: string) => void;
    disabled: boolean;
  }) => (
    <select
      aria-label="New agent permissions"
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
  projectAgentPermissionLabel: (mode: string | undefined) => mode ?? "Permissions unavailable",
}));
vi.mock("../ui/dialog", async () => {
  const { createContext, useContext } = await import("react");
  const Context = createContext({ open: false, onOpenChange: (_open: boolean) => {} });
  const Container = ({ children }: PropsWithChildren) => <div>{children}</div>;
  return {
    Dialog: (
      props: PropsWithChildren<{ open: boolean; onOpenChange: (open: boolean) => void }>,
    ) => <Context value={props}>{props.children}</Context>,
    DialogPopup: ({ children }: PropsWithChildren) => {
      const context = useContext(Context);
      return context.open ? (
        <div role="dialog">
          <button onClick={() => context.onOpenChange(false)}>Close review</button>
          {children}
        </div>
      ) : null;
    },
    DialogHeader: Container,
    DialogTitle: Container,
    DialogDescription: Container,
    DialogPanel: Container,
    DialogFooter: Container,
  };
});

import { ProjectAgentProposalPanel } from "./ProjectAgentProposalPanel";

const projectId = ProjectId.make("project");
const instanceId = ProviderInstanceId.make("meerkat");
const sourceThreadId = ThreadId.make("setup");
const proposal: MeerkatProjectAgentProposal = {
  proposalId: "proposal",
  title: "Project specialists",
  summary: null,
  agents: [
    {
      id: "architect",
      role: "architect",
      label: "Architect",
      focus: "Runtime",
      charter: "Own the runtime.",
      ownershipPaths: ["src/runtime"],
      recommended: true,
    },
  ],
};
const prepared: MeerkatProjectAgent = {
  ...proposal.agents[0]!,
  agentId: "architect-agent",
  projectId,
  instanceId,
  instructions: "Own the runtime.",
  model: "openai:model",
  accessMode: "full-access",
  enabled: true,
  archived: false,
  connectionStatus: "connected",
  agentRef: "native-agent",
  error: null,
  createdAt: "2026-09-29T07:00:00.000Z",
  updatedAt: "2026-09-29T07:01:00.000Z",
  preparation: {
    assignmentId: "study",
    fingerprint: "assignment",
    attempt: 1,
    status: "ready",
    requestId: "request",
    interactionId: "interaction",
    inputFrameId: "input",
    error: null,
    updatedAt: "2026-09-29T07:01:00.000Z",
  },
};
const props = {
  environmentId: EnvironmentId.make("local"),
  projectId,
  sourceThreadId,
  projectTitle: "Project",
  busy: false,
  modelSelection: { instanceId, model: "openai:model" },
  runtimeMode: "full-access" as const,
};
let renderer: ReactTestRenderer | undefined;
const button = (label: string) =>
  renderer!.root
    .findAllByType("button")
    .find((node) => node.children.filter((child) => typeof child !== "object").join("") === label)!;
const content = () => JSON.stringify(renderer!.toJSON());
const render = () =>
  act(() => {
    if (renderer) renderer.update(<ProjectAgentProposalPanel {...props} />);
    else renderer = create(<ProjectAgentProposalPanel {...props} />);
  });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.proposal = {
    projectId,
    sourceThreadId,
    instanceId,
    model: "openai:model",
    isSetupThread: true,
    isSourceThreadPersisted: true,
    available: true,
    status: "ready",
    error: null,
    proposal,
  };
  state.team = {
    projectId,
    observedAt: "2026-09-29T07:00:00.000Z",
    observation: "loaded_runtimes",
    providers: [],
    projectAgents: [],
  };
  state.teamError = null;
  state.create.mockReset();
  state.prepare.mockReset();
  state.startTurn.mockReset();
  state.refresh.mockReset();
  state.navigate.mockReset();
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("proposal command recovery", () => {
  it.each(["read-only", "full-access"])(
    "uses the chosen permissions for new agents: %s",
    async (mode) => {
      state.create.mockResolvedValueOnce({
        _tag: "Success",
        value: {
          results: [
            { candidateId: "architect", agent: { ...prepared, accessMode: mode }, error: null },
          ],
        },
      });
      render();
      act(() => button("Review proposal").props.onClick());
      const permissions = renderer!.root.findByProps({ "aria-label": "New agent permissions" });
      expect(permissions.props.value).toBe("read-only");
      act(() => permissions.props.onChange({ target: { value: mode } }));
      await act(async () => button("Apply 1 assignment").props.onClick());
      expect(state.create).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({ accessMode: mode, candidateIds: ["architect"] }),
        }),
      );
    },
  );

  it("shows an existing specialist's actual permissions without offering a mode change", () => {
    state.team = { ...state.team!, projectAgents: [prepared] };
    render();
    act(() => button("View agents").props.onClick());
    expect(renderer!.root.findAllByProps({ "aria-label": "New agent permissions" })).toHaveLength(
      0,
    );
    expect(content()).toContain("full-access");
    expect(content()).toContain("Existing agents keep their permissions");
  });

  it.each([true, false])(
    "keeps a failed request visible when review closes before completion: %s",
    async (closeWhilePending) => {
      let complete: (value: unknown) => void = () => {};
      state.create.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      );
      render();
      act(() => button("Review proposal").props.onClick());
      act(() => button("Apply 1 assignment").props.onClick());
      if (closeWhilePending) act(() => button("Close review").props.onClick());
      await act(async () => complete({ _tag: "Failure", cause: "Assignment service unavailable" }));
      if (!closeWhilePending) act(() => button("Close review").props.onClick());

      expect(renderer!.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
      expect(renderer!.root.findByProps({ role: "alert" }).children).toContain(
        "Assignment service unavailable",
      );
      expect(button("Review issues")).toBeDefined();

      act(() => button("Review issues").props.onClick());
      state.create.mockResolvedValueOnce({
        _tag: "Success",
        value: { results: [{ candidateId: "architect", agent: prepared, error: null }] },
      });
      await act(async () => button("Apply 1 assignment").props.onClick());
      act(() => button("Close review").props.onClick());
      expect(state.create).toHaveBeenCalledTimes(2);
      expect(renderer!.root.findAllByProps({ role: "alert" })).toHaveLength(0);
      expect(content()).toContain("1 agent ready");
      expect(button("View agents")).toBeDefined();
    },
  );

  it("surfaces a failed roster observation over previously ready progress and offers recovery", () => {
    state.team = { ...state.team!, projectAgents: [prepared] };
    state.teamError = "Could not load project agents";
    render();
    expect(content()).toContain("Needs attention");
    expect(renderer!.root.findByProps({ role: "alert" }).children).toContain(state.teamError);
    act(() => button("Review issues").props.onClick());
    act(() => button("Retry loading agents").props.onClick());
    expect(state.refresh).toHaveBeenCalledOnce();
    state.teamError = null;
    render();
    act(() => button("Close review").props.onClick());
    expect(content()).toContain("1 agent ready");
    expect(renderer!.root.findAllByProps({ role: "alert" })).toHaveLength(0);
  });
});
