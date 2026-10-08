import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import { act, useState, type ComponentProps, type ReactNode } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import type { Project } from "../../types";

vi.mock("../ui/button", () => ({
  Button: ({
    children,
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & {
    variant?: string;
    size?: string;
  }) => <button {...props}>{children}</button>,
}));
vi.mock("../ui/menu", async () => {
  const { cloneElement, createContext, useContext, useState } = await import("react");
  const MenuState = createContext({ open: false, setOpen: (_open: boolean) => {} });
  const childrenOnly = ({ children }: { children: ReactNode }) => children;
  return {
    Menu: ({ children }: { children: ReactNode }) => {
      const [open, setOpen] = useState(false);
      return <MenuState.Provider value={{ open, setOpen }}>{children}</MenuState.Provider>;
    },
    MenuTrigger: ({
      render,
      children,
    }: {
      render: React.ReactElement<ComponentProps<"button">>;
      children: ReactNode;
    }) => {
      const menu = useContext(MenuState);
      return cloneElement(
        render,
        {
          "aria-haspopup": "menu",
          "aria-expanded": menu.open,
          onClick: (event) => {
            render.props.onClick?.(event);
            if (!event.defaultPrevented) menu.setOpen(!menu.open);
          },
        },
        children,
      );
    },
    MenuPopup: ({ children }: { children: ReactNode }) =>
      useContext(MenuState).open ? <div role="menu">{children}</div> : null,
    MenuGroup: childrenOnly,
    MenuGroupLabel: childrenOnly,
    MenuItem: ({ children, onClick, ...props }: ComponentProps<"button">) => {
      const menu = useContext(MenuState);
      return (
        <button
          {...props}
          role="menuitem"
          onClick={(event) => {
            onClick?.(event);
            menu.setOpen(false);
          }}
        >
          {children}
        </button>
      );
    },
  };
});

import { SidebarProjectNavigation } from "./SidebarProjectNavigation";

const environmentId = EnvironmentId.make("same-machine");
const first = makeProject("first", "/work/first/shared-repo");
const second = makeProject("second", "/work/second/shared-repo");
let renderer: ReactTestRenderer | undefined;

function makeProject(id: string, workspaceRoot: string, environment = environmentId): Project {
  return {
    id: ProjectId.make(id),
    environmentId: environment,
    title: "shared-repo",
    workspaceRoot,
    repositoryIdentity: {
      canonicalKey: "github.com/fixture/shared-repo",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://github.com/fixture/shared-repo.git",
      },
    },
    defaultModelSelection: { instanceId: ProviderInstanceId.make("native"), model: "fixture" },
    createdAt: "2026-10-05T00:00:00.000Z",
    updatedAt: "2026-10-05T00:00:00.000Z",
    scripts: [],
  };
}

function Fixture({
  projects,
  agentEnvironments = [environmentId],
}: {
  projects: Project[];
  agentEnvironments?: EnvironmentId[];
}) {
  const [destination, setDestination] = useState("unchanged");
  const project = buildSidebarProjectSnapshots({
    projects,
    settings: { sidebarProjectGroupingMode: "repository", sidebarProjectGroupingOverrides: {} },
    primaryEnvironmentId: environmentId,
    resolveEnvironmentLabel: (id) => (id === environmentId ? "Local fixture" : "Remote fixture"),
  })[0]!;
  const open = (action: string) => (target: ScopedProjectRef) =>
    setDestination(`${action}:${target.environmentId}:${target.projectId}`);
  return (
    <>
      <summary>
        <SidebarProjectNavigation
          project={project}
          attention={null}
          supportsAgents={(id) => agentEnvironments.includes(id)}
          onOpenProject={open("project")}
          onNewThread={open("thread")}
          onProposeAgents={open("propose")}
          onAddAgent={open("add")}
          onSettings={() => setDestination("settings")}
        />
      </summary>
      <output>{destination}</output>
    </>
  );
}

function text(node: ReactTestInstance | string): string {
  return typeof node === "string" ? node : node.children.map(text).join("");
}
function button(label: string) {
  return renderer!.root
    .findAllByType("button")
    .find((node) => (node.props["aria-label"] ?? text(node)) === label)!;
}
async function click(label: string) {
  const event = {
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {},
  };
  await act(async () => button(label).props.onClick(event));
}
const destination = () => text(renderer!.root.findByType("output"));
async function render(projects: Project[], agentEnvironments?: EnvironmentId[]) {
  await act(async () => {
    renderer = create(
      <Fixture projects={projects} {...(agentEnvironments ? { agentEnvironments } : {})} />,
    );
  });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

it("asks for a checkout before opening or starting a thread in a grouped repository", async () => {
  await render([first, second]);
  await click("Open shared-repo project");
  expect(destination()).toBe("unchanged");
  const menu = renderer!.root.findByProps({ role: "menu" });
  expect(text(menu)).toContain(first.workspaceRoot);
  expect(text(menu)).toContain(second.workspaceRoot);
  await click("Open Local fixture - /work/second/shared-repo");
  expect(destination()).toBe("project:same-machine:second");

  await click("New thread in shared-repo");
  expect(destination()).toBe("project:same-machine:second");
  await act(async () => renderer!.update(<Fixture projects={[second, first]} />));
  await click("New thread in Local fixture - /work/first/shared-repo");
  expect(destination()).toBe("thread:same-machine:first");
});

it("distinguishes Add and Propose targets on the same environment and excludes unsupported environments", async () => {
  const remote = makeProject("first", first.workspaceRoot, EnvironmentId.make("remote-machine"));
  await render([first, second, remote]);
  await click("Project actions for shared-repo");
  expect(button(`Propose agents in Remote fixture - ${remote.workspaceRoot}`)).toBeUndefined();
  expect(button(`Add agent in Remote fixture - ${remote.workspaceRoot}`)).toBeUndefined();
  await click("Propose agents in Local fixture - /work/second/shared-repo");
  expect(destination()).toBe("propose:same-machine:second");
  await click("Project actions for shared-repo");
  await click("Add agent in Local fixture - /work/first/shared-repo");
  expect(destination()).toBe("add:same-machine:first");

  await click("Open shared-repo project");
  await click(`Open Remote fixture - ${remote.workspaceRoot}`);
  expect(destination()).toBe("project:remote-machine:first");
});

it("keeps single-checkout project and thread actions direct", async () => {
  await render([second]);
  await click("Open shared-repo project");
  expect(destination()).toBe("project:same-machine:second");
  expect(renderer!.root.findAllByProps({ role: "menu" })).toHaveLength(0);
  await click("New thread in shared-repo");
  expect(destination()).toBe("thread:same-machine:second");
  await click("Project actions for shared-repo");
  await click("Propose agents from repository");
  expect(destination()).toBe("propose:same-machine:second");
  await click("Project actions for shared-repo");
  await click("Add agent");
  expect(destination()).toBe("add:same-machine:second");
});
