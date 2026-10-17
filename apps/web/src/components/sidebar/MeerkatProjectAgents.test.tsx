import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type MeerkatAttentionItem,
} from "@t3tools/contracts";
import { act, useEffect, type ComponentProps, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  activeObservers: 0,
  observationStarts: 0,
  activeAttention: 0,
  subscriptions: [] as unknown[],
  items: [] as MeerkatAttentionItem[],
  project: {
    environmentId: "environment",
    id: "project",
    title: "Project",
    workspaceRoot: "/work/first/project",
  },
  otherProjects: [] as {
    environmentId: string;
    id: string;
    title: string;
    workspaceRoot: string;
  }[],
}));
vi.mock("../../state/meerkatAttention", () => ({
  useMeerkatAttention: () => {
    useEffect(() => {
      state.activeAttention += 1;
      return () => {
        state.activeAttention -= 1;
      };
    }, []);
    return { data: { items: state.items }, error: null };
  },
}));
vi.mock("../../state/meerkatTeam", () => ({
  meerkatTeamEnvironment: { projectTeam: () => "full-team" },
  useVisibleTeamRefresh: (_query: unknown, enabled: boolean) => {
    useEffect(() => {
      if (!enabled) return;
      state.activeObservers += 1;
      state.observationStarts += 1;
      return () => {
        state.activeObservers -= 1;
      };
    }, [enabled]);
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (query: unknown) => {
    state.subscriptions.push(query);
    return { data: { providers: [], projectAgents: [] }, error: null, isPending: false };
  },
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => [state.project, ...state.otherProjects],
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: [
      {
        environmentId: "environment",
        entry: { target: { _tag: "PrimaryConnectionTarget" } },
        label: "Local fixture",
        serverConfig: { providers: [{ driver: "meerkat" }] },
      },
    ],
  }),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => () => {},
  useLocation: () => ({ pathname: "/", searchStr: "" }),
}));
vi.mock("../ui/sidebar", () => ({
  useSidebar: () => ({ isMobile: false, setOpenMobile: () => {} }),
  SidebarMenu: ({ children }: { children: ReactNode }) => <ul>{children}</ul>,
  SidebarMenuItem: ({ children }: { children: ReactNode }) => <li>{children}</li>,
  SidebarMenuButton: ({ children, ...props }: ComponentProps<"button">) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: ReactNode }) => render,
  TooltipPopup: () => null,
}));
vi.mock("../team/MeerkatPeerConnections", () => ({
  useMeerkatPeerConnections: () => null,
  useMeerkatPeerDrag: () => ({ dragProps: {}, isDropTarget: false }),
}));
vi.mock("../team/MeerkatActivityOverview", () => ({ MeerkatActivityOverview: () => null }));

import { MeerkatProjectAgents, MeerkatProjectAttention } from "./MeerkatProjectAgents";
const environmentId = EnvironmentId.make("environment");
const projectId = ProjectId.make("project");
const projectRefs = [{ environmentId, projectId }];
const attentionItem: MeerkatAttentionItem = {
  id: "request-a",
  projectId,
  instanceId: ProviderInstanceId.make("native"),
  agentRef: "agent",
  sessionId: "session",
  projectAgentId: "specialist",
  threadId: null,
  coordinator: false,
  label: "Specialist",
  kind: "question",
  title: "Needs input",
  detail: "Review the request",
  question: null,
  completionStatus: null,
  active: true,
  unread: true,
  createdAt: "2026-09-29T00:00:00.000Z",
  updatedAt: "2026-09-29T00:00:00.000Z",
};
let renderer: ReactTestRenderer | undefined;
const body = (visible: boolean) => (
  <>
    <MeerkatProjectAttention projectRefs={projectRefs} />
    <MeerkatProjectAgents projectRefs={projectRefs} visible={visible} />
  </>
);
const render = async (visible = true) => {
  await act(async () => {
    renderer = create(body(visible));
  });
};
const show = async (visible: boolean) => {
  await act(async () => renderer!.update(body(visible)));
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", globalThis);
  vi.useFakeTimers();
  state.activeObservers = 0;
  state.observationStarts = 0;
  state.activeAttention = 0;
  state.subscriptions = [];
  state.items = [attentionItem];
  state.otherProjects = [];
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("stops full roster observation and its clock on project collapse while retaining attention", async () => {
  await render();
  expect(state.activeObservers).toBe(1);
  expect(vi.getTimerCount()).toBe(1);
  await show(false);
  expect(state.activeObservers).toBe(0);
  expect(state.subscriptions.at(-1)).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
  expect(state.activeAttention).toBeGreaterThan(0);
  expect(JSON.stringify(renderer!.toJSON())).toContain("Needs input");

  await show(true);
  expect(state.activeObservers).toBe(1);
  expect(state.observationStarts).toBe(2);
  expect(vi.getTimerCount()).toBe(1);
  await show(true);
  expect(state.observationStarts).toBe(2);
  expect(state.activeObservers).toBe(1);
});

it("mounts a collapsed project without requesting a full roster and keeps attention current", async () => {
  await render(false);
  expect(state.subscriptions).toEqual([null]);
  expect(state.activeObservers).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  state.items = [
    { ...attentionItem, kind: "completion", active: false, completionStatus: "completed" },
  ];
  await show(false);
  expect(JSON.stringify(renderer!.toJSON())).toContain("Unread");
  expect(state.subscriptions.every((query) => query === null)).toBe(true);
});

it("preserves the user's inner Agents collapse across outer collapse and reopen", async () => {
  await render();
  await act(async () =>
    renderer!.root.findByProps({ "aria-label": "Collapse project agents" }).props.onClick(),
  );
  expect(state.activeObservers).toBe(0);
  await show(false);
  await show(true);
  expect(state.activeObservers).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  await act(async () =>
    renderer!.root.findByProps({ "aria-label": "Expand project agents" }).props.onClick(),
  );
  expect(state.activeObservers).toBe(1);
  expect(state.observationStarts).toBe(2);
});

it("identifies same-named checkouts and collapses only the selected roster", async () => {
  state.otherProjects = [
    { ...state.project, id: "second-project", workspaceRoot: "/work/second/project" },
  ];
  await act(async () => {
    renderer = create(
      <MeerkatProjectAgents
        projectRefs={[
          ...projectRefs,
          { environmentId, projectId: ProjectId.make("second-project") },
        ]}
      />,
    );
  });
  expect(state.activeObservers).toBe(2);
  await act(async () => {
    renderer!.root
      .findByProps({
        "aria-label": "Collapse project agents in Local fixture - /work/second/project",
      })
      .props.onClick();
  });
  expect(state.activeObservers).toBe(1);
  expect(vi.getTimerCount()).toBe(1);
  await act(async () => {
    renderer!.root
      .findByProps({
        "aria-label": "Collapse project agents in Local fixture - /work/first/project",
      })
      .props.onClick();
  });
  expect(state.activeObservers).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});
