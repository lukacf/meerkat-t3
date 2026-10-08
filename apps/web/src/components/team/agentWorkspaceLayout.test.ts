import { afterEach, expect, it, vi } from "vite-plus/test";
import { isolateAgentWorkspaceTools, resolveAgentWorkspaceLayout } from "./agentWorkspaceLayout";

afterEach(() => vi.unstubAllGlobals());

it("uses the full pane when a short window cannot fit both tools and conversation", () => {
  for (const height of [180, 300, 360, 420, 599]) {
    for (const expanded of [false, true]) {
      expect(resolveAgentWorkspaceLayout(height, expanded)).toEqual({
        fullPane: true,
        height: "100%",
      });
    }
  }
});

it("reserves conversation space once there is room for a usable inline workspace", () => {
  for (const paneHeight of [600, 720, 780, 900, 1400]) {
    const layout = resolveAgentWorkspaceLayout(paneHeight, false);
    expect(layout.fullPane).toBe(false);
    expect(layout.height).toBeGreaterThanOrEqual(240);
    expect(layout.height).toBeLessThanOrEqual(paneHeight - 360);
  }
  expect(resolveAgentWorkspaceLayout(0, false).height).toBe("max(240px, 35vh)");
});

it("uses the whole pane when the user expands tools, even when an inline layout fits", () => {
  for (const paneHeight of [0, 600, 720, 780, 900, 1400]) {
    expect(resolveAgentWorkspaceLayout(paneHeight, true)).toEqual({
      fullPane: true,
      height: "100%",
    });
  }
});

class TestElement {
  inert = false;
  parentElement: TestElement | null = null;
  children: TestElement[] = [];
  append(child: TestElement) {
    this.children.push(child);
    child.parentElement = this;
  }
  contains(target: TestElement): boolean {
    return target === this || this.children.some((child) => child.contains(target));
  }
}

it("isolates only covered siblings, includes newly mounted controls, and restores prior inert state", () => {
  let mutation: (() => void) | undefined;
  const observed: unknown[] = [];
  const disconnect = vi.fn();
  vi.stubGlobal("HTMLElement", TestElement);
  vi.stubGlobal(
    "MutationObserver",
    class {
      constructor(callback: () => void) {
        mutation = callback;
      }
      observe(node: unknown) {
        observed.push(node);
      }
      disconnect = disconnect;
    },
  );
  const app = new TestElement();
  const sidebar = new TestElement();
  const pane = new TestElement();
  const container = new TestElement();
  const header = new TestElement();
  const panel = new TestElement();
  const conversation = new TestElement();
  const previouslyInert = new TestElement();
  previouslyInert.inert = true;
  app.append(sidebar);
  app.append(pane);
  pane.append(container);
  pane.append(previouslyInert);
  container.append(header);
  container.append(panel);
  container.append(conversation);
  const restore = isolateAgentWorkspaceTools(
    panel as unknown as HTMLElement,
    pane as unknown as HTMLElement,
  );
  expect(header.inert).toBe(true);
  expect(conversation.inert).toBe(true);
  expect(panel.inert).toBe(false);
  expect(container.inert).toBe(false);
  expect(sidebar.inert).toBe(false);
  expect(observed).toEqual([container, pane]);
  const notice = new TestElement();
  container.append(notice);
  mutation!();
  expect(notice.inert).toBe(true);
  restore();
  expect(header.inert).toBe(false);
  expect(conversation.inert).toBe(false);
  expect(notice.inert).toBe(false);
  expect(previouslyInert.inert).toBe(true);
  expect(disconnect).toHaveBeenCalledOnce();
});
