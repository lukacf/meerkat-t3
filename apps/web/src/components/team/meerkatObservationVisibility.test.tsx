import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
const state = vi.hoisted(() => ({
  selected: [] as unknown[],
  refresh: [] as boolean[],
  project: { environmentId: "environment", id: "project", title: "Project" },
}));
vi.mock("../../state/meerkatAttention", () => ({
  useMeerkatAttention: () => ({ data: { items: [] } }),
}));
vi.mock("../../state/meerkatTeam", () => ({
  meerkatTeamEnvironment: { projectTeam: () => "full-team" },
  useVisibleTeamRefresh: (_query: unknown, enabled: boolean) => state.refresh.push(enabled),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (selected: unknown) => {
    state.selected.push(selected);
    return {
      data: selected ? { providers: [], projectAgents: [] } : null,
      error: null,
      isPending: false,
    };
  },
}));
vi.mock("../../state/entities", () => ({ useProjects: () => [state.project] }));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: [
      { environmentId: "environment", serverConfig: { providers: [{ driver: "meerkat" }] } },
    ],
  }),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => () => {},
  useLocation: () => ({ pathname: "/", searchStr: "" }),
}));
vi.mock("../ui/sidebar", () => ({
  useSidebar: () => ({ isMobile: false, setOpenMobile: () => {} }),
  SidebarMenu: ({ children }: any) => <ul>{children}</ul>,
  SidebarMenuItem: ({ children }: any) => <li>{children}</li>,
  SidebarMenuButton: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}));
vi.mock("./MeerkatPeerConnections", () => ({
  useMeerkatPeerConnections: () => null,
  useMeerkatPeerDrag: () => ({ dragProps: {}, isDropTarget: false }),
}));
vi.mock("../ui/button", () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: any) => children,
  TooltipTrigger: ({ render, children }: any) => (
    <>
      {render}
      {children}
    </>
  ),
  TooltipPopup: () => null,
}));
vi.mock("../ui/popover", () => ({
  Popover: ({ children, open, onOpenChange }: any) => (
    <div data-open={open}>
      <button aria-label="Toggle work" onClick={() => onOpenChange(!open)} />
      {children}
    </div>
  ),
  PopoverTrigger: ({ children }: any) => <div>{children}</div>,
  PopoverPopup: ({ children }: any) => <div>{children}</div>,
  PopoverTitle: ({ children }: any) => <div>{children}</div>,
}));
import { MeerkatActivityOverview } from "./MeerkatActivityOverview";
import { MeerkatProjectAgents } from "../sidebar/MeerkatProjectAgents";
let renderer: ReactTestRenderer | undefined;
const environmentId = EnvironmentId.make("environment"),
  projectId = ProjectId.make("project");
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", globalThis);
  vi.useFakeTimers();
  state.selected = [];
  state.refresh = [];
});
afterEach(() => {
  act(() => renderer?.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("does not subscribe to full native work or run a clock while its popover is closed", async () => {
  await act(async () => {
    renderer = create(
      <MeerkatActivityOverview environmentId={environmentId} projectId={projectId} />,
    );
  });
  expect(state.selected.at(-1)).toBeNull();
  expect(state.refresh.at(-1)).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
  await act(async () =>
    renderer!.root.findByProps({ "aria-label": "Toggle work" }).props.onClick(),
  );
  expect(state.selected.at(-1)).toBe("full-team");
  expect(state.refresh.at(-1)).toBe(true);
  expect(vi.getTimerCount()).toBe(1);
  await act(async () =>
    renderer!.root.findByProps({ "aria-label": "Toggle work" }).props.onClick(),
  );
  expect(state.selected.at(-1)).toBeNull();
  expect(state.refresh.at(-1)).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
it("collapsing project agents stops full refresh and clock work but retains the cached roster query", async () => {
  await act(async () => {
    renderer = create(<MeerkatProjectAgents projectRefs={[{ environmentId, projectId }]} />);
  });
  expect(state.refresh).toContain(true);
  expect(vi.getTimerCount()).toBe(1);
  state.refresh = [];
  state.selected = [];
  await act(async () =>
    renderer!.root.findByProps({ "aria-label": "Collapse project agents" }).props.onClick(),
  );
  expect(state.refresh).not.toContain(true);
  expect(state.selected).toContain("full-team");
  expect(vi.getTimerCount()).toBe(0);
  await act(async () =>
    renderer!.root.findByProps({ "aria-label": "Expand project agents" }).props.onClick(),
  );
  expect(state.refresh).toContain(true);
  expect(vi.getTimerCount()).toBe(1);
});
