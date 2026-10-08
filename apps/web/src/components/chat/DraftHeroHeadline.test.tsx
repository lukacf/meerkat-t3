import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts/settings";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { Project } from "../../types";

const state = vi.hoisted(() => ({ projects: [] as Project[], driver: "meerkat" }));
vi.mock("../../state/entities", () => ({
  useProjects: () => state.projects,
  useThreadShells: () => [],
}));
vi.mock("../../state/environments", () => ({
  usePrimaryEnvironmentId: () => EnvironmentId.make("local"),
  useEnvironments: () => ({
    environments: [
      {
        environmentId: EnvironmentId.make("local"),
        label: "This Mac",
        serverConfig: {
          environment: { platform: { os: "darwin", machine: "laptop" } },
          providers: [{ driver: state.driver }],
        },
      },
      {
        environmentId: EnvironmentId.make("remote"),
        label: "Build server",
        serverConfig: {
          environment: { platform: { os: "linux", machine: "server" } },
          providers: [{ driver: state.driver }],
        },
      },
    ],
  }),
}));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: (select: (settings: ClientSettings) => unknown) =>
    select({
      ...DEFAULT_CLIENT_SETTINGS,
      sidebarProjectGroupingMode: "repository",
    }),
}));
vi.mock("../ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("../ProjectEnvironmentBadge", () => ({ ProjectEnvironmentBadge: () => null }));
vi.mock("../ui/button", () => ({ InlineButton: "button" }));
vi.mock("../ui/menu", async () => {
  const { cloneElement, isValidElement } = await import("react");
  const childrenOnly = ({ children }: { children: ReactNode }) => children;
  return {
    Menu: childrenOnly,
    MenuPopup: childrenOnly,
    MenuSeparator: "hr",
    MenuItem: "button",
    MenuTrigger: ({ render, children }: { render: ReactNode; children: ReactNode }) =>
      isValidElement(render) ? cloneElement(render, undefined, children) : children,
    MenuRadioGroup: ({
      value,
      onValueChange,
      children,
    }: {
      value: string;
      onValueChange: (value: string) => void;
      children: ReactNode;
    }) => (
      <select value={value} onChange={(event) => onValueChange(event.target.value)}>
        {children}
      </select>
    ),
    MenuRadioItem: ({
      value,
      children,
      "aria-label": label,
    }: {
      value: string;
      children: ReactNode;
      "aria-label"?: string;
    }) => (
      <option value={value} aria-label={label}>
        {children}
      </option>
    ),
  };
});
vi.mock("../ui/tooltip", async () => {
  const { cloneElement, isValidElement } = await import("react");
  return {
    Tooltip: ({ children }: { children: ReactNode }) => children,
    TooltipPopup: () => null,
    TooltipTrigger: ({ render, children }: { render: ReactNode; children: ReactNode }) =>
      isValidElement(render) ? cloneElement(render, undefined, children) : children,
  };
});

import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { derivePhysicalProjectKey } from "../../logicalProject";
import { DraftHeroHeadline } from "./DraftHeroHeadline";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const draftId = DraftId.make("checkout-choice");
const instanceId = ProviderInstanceId.make("native-work");
const repositoryIdentity = {
  canonicalKey: "github.com/example/same-repo",
  locator: {
    source: "git-remote" as const,
    remoteName: "origin",
    remoteUrl: "https://github.com/example/same-repo.git",
  },
};
const savedModel = {
  instanceId,
  model: "openai:chosen",
  options: [{ id: "reasoning_effort", value: "high" }],
};
function project(id: string, workspaceRoot: string, environmentId = local): Project {
  return {
    id: ProjectId.make(id),
    environmentId,
    title: "same-repo",
    workspaceRoot,
    repositoryIdentity,
    defaultModelSelection: { instanceId, model: `openai:${id}` },
    createdAt: "2026-10-05T00:00:00.000Z",
    updatedAt: "2026-10-05T00:00:00.000Z",
    scripts: [],
  };
}
let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  state.driver = "meerkat";
  state.projects = [
    project("first", "/work/first/same-repo"),
    project("second", "/work/second/same-repo"),
    project("first", "/remote/same-repo", remote),
  ];
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    stickyModelSelectionByProvider: {},
    stickyActiveProvider: null,
  });
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
});

it("switches same-group checkouts and environments without losing the open draft or explicit model", async () => {
  const first = state.projects[0]!;
  const second = state.projects[1]!;
  const remoteCopy = state.projects[2]!;
  const store = useComposerDraftStore.getState();
  store.setLogicalProjectDraftThreadId(
    repositoryIdentity.canonicalKey,
    scopeProjectRef(local, first.id),
    draftId,
    { environmentSelection: "auto", loadBalancedEnvironmentId: local },
  );
  store.setPrompt(draftId, "Keep this work and reasoning choice");
  store.setModelSelection(draftId, savedModel, { explicit: true });
  const renderFor = (active: Project) => (
    <DraftHeroHeadline
      draftId={draftId}
      activeProjectRef={scopeProjectRef(active.environmentId, active.id)}
      activeProjectTitle={active.title}
    />
  );
  await act(async () => {
    renderer = create(renderFor(first));
  });
  expect(renderer!.root.findAllByType("option")).toHaveLength(3);
  for (const target of [second, remoteCopy, first]) {
    const choice = renderer!.root
      .findAllByType("option")
      .find((option) => option.props.value === derivePhysicalProjectKey(target))!;
    expect(choice.props["aria-label"]).toContain(target.workspaceRoot);
    expect(choice.props["aria-label"]).toContain(
      target.environmentId === local ? "This Mac" : "Build server",
    );
    await act(async () => {
      renderer!.root.findByType("select").props.onChange({ target: { value: choice.props.value } });
    });
    expect(store.getDraftThread(draftId)).toMatchObject({
      environmentId: target.environmentId,
      projectId: target.id,
      logicalProjectKey: repositoryIdentity.canonicalKey,
      environmentSelection: "manual",
      loadBalancedEnvironmentId: null,
    });
    expect(store.getComposerDraft(draftId)).toMatchObject({
      prompt: "Keep this work and reasoning choice",
      activeProvider: instanceId,
      modelSelectionByProvider: { [instanceId]: savedModel },
      modelSelectionExplicit: true,
    });
    await act(async () => {
      renderer!.update(renderFor(target));
    });
    expect(renderer!.root.findByType("select").props.value).toBe(derivePhysicalProjectKey(target));
  }
  expect(store.listDraftThreadKeys()).toHaveLength(1);
});

it("applies the explicitly selected checkout default when the draft has no explicit model", async () => {
  const first = state.projects[0]!;
  const second = state.projects[1]!;
  const store = useComposerDraftStore.getState();
  store.setLogicalProjectDraftThreadId(
    repositoryIdentity.canonicalKey,
    scopeProjectRef(local, first.id),
    draftId,
  );
  store.setPrompt(draftId, "Keep this prompt");
  await act(async () => {
    renderer = create(
      <DraftHeroHeadline
        draftId={draftId}
        activeProjectRef={scopeProjectRef(local, first.id)}
        activeProjectTitle={first.title}
      />,
    );
  });
  await act(async () => {
    renderer!.root
      .findByType("select")
      .props.onChange({ target: { value: derivePhysicalProjectKey(second) } });
  });
  expect(store.getDraftThread(draftId)?.projectId).toBe(second.id);
  expect(store.getComposerDraft(draftId)).toMatchObject({
    prompt: "Keep this prompt",
    modelSelectionByProvider: { [instanceId]: second.defaultModelSelection },
  });
});
