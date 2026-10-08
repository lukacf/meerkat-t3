import { EnvironmentId } from "@t3tools/contracts";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("~/components/ui/button", () => ({ Button: "button" }));
vi.mock("~/components/ui/textarea", () => ({ Textarea: "textarea" }));
vi.mock("./fileSurfaceChrome", () => ({ FileSurfaceNotice: "aside" }));
const { addToast } = vi.hoisted(() => ({ addToast: vi.fn() }));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: addToast } }));

import { FileEditRecoveryNotice } from "./FileEditRecoveryNotice";
import { createFileEditRecoveryStore } from "./fileEditRecoveryStore";

const target = {
  environmentId: EnvironmentId.make("recovery-ui"),
  cwd: "/workspace",
  relativePath: "file.txt",
};
const writeText = vi.fn();
const renderers: ReactTestRenderer[] = [];

function fixture() {
  const values = new Map<string, string>();
  const storage = {
    get length() {
      return values.size;
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
  };
  createFileEditRecoveryStore(() => storage, "old-window").capture(target, "recovered text\n");
  return { storage, store: createFileEditRecoveryStore(() => storage, "new-window") };
}

function render(store: ReturnType<typeof createFileEditRecoveryStore>) {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      createElement(FileEditRecoveryNotice, {
        ...target,
        store,
        contents: "newer disk contents",
        saveFailed: false,
      }),
    );
  });
  renderers.push(renderer);
  return renderer;
}

function button(renderer: ReactTestRenderer, label: string) {
  return renderer.root.findAllByType("button").find((node) => node.children.join("") === label)!;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {});
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  writeText.mockReset().mockResolvedValue(undefined);
  addToast.mockReset();
});

afterEach(() => {
  for (const renderer of renderers.splice(0)) act(() => renderer.unmount());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("recovered file copy controls", () => {
  it("copies exact recovery text without discarding it, then explicitly discards it across reopen", async () => {
    const { store, storage } = fixture();
    const renderer = render(store);
    await act(async () => {
      button(renderer, "Copy recovered edits").props.onClick();
    });
    expect(writeText).toHaveBeenCalledExactlyOnceWith("recovered text\n");
    expect(store.getSnapshot(target).copies).toHaveLength(1);
    act(() => {
      button(renderer, "Discard recovery copy").props.onClick();
    });
    expect(renderer.root.findAllByType("textarea")).toHaveLength(0);
    expect(
      createFileEditRecoveryStore(() => storage, "reopened").getSnapshot(target).copies,
    ).toEqual([]);
  });

  it("keeps the recovery copy after clipboard failure and after failed Discard, allowing a retry", async () => {
    const { store, storage } = fixture();
    writeText.mockRejectedValue(new Error("synthetic clipboard failure"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const renderer = render(store);
    await act(async () => {
      button(renderer, "Copy recovered edits").props.onClick();
    });
    expect(addToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Could not copy unsaved edits" }),
    );
    expect(store.getSnapshot(target).copies).toHaveLength(1);
    storage.removeItem.mockImplementationOnce(() => {
      throw new Error("synthetic remove failure");
    });
    act(() => {
      button(renderer, "Discard recovery copy").props.onClick();
    });
    expect(JSON.stringify(renderer.toJSON())).toContain("could not be discarded");
    expect(store.getSnapshot(target).copies).toHaveLength(1);
    act(() => {
      button(renderer, "Discard recovery copy").props.onClick();
    });
    expect(store.getSnapshot(target).copies).toEqual([]);
  });

  it("switching checkout shows only that checkout's recovery and preserves the original", () => {
    const { store } = fixture();
    const renderer = render(store);
    act(() => {
      renderer.update(
        createElement(FileEditRecoveryNotice, {
          ...target,
          cwd: "/other",
          store,
          contents: "other disk",
          saveFailed: false,
        }),
      );
    });
    expect(renderer.root.findAllByType("textarea")).toHaveLength(0);
    expect(store.getSnapshot(target).copies).toHaveLength(1);
    act(() => {
      renderer.update(
        createElement(FileEditRecoveryNotice, {
          ...target,
          store,
          contents: "newer disk contents",
          saveFailed: false,
        }),
      );
    });
    expect(renderer.root.findByType("textarea").props.value).toBe("recovered text\n");
  });

  it("offers the newest in-memory text when restart storage is unavailable", async () => {
    const store = createFileEditRecoveryStore(() => undefined, "unavailable");
    store.capture(target, "latest memory only");
    const renderer = render(store);
    expect(JSON.stringify(renderer.toJSON())).toContain("only kept in this window");
    await act(async () => {
      button(renderer, "Copy unsaved edits").props.onClick();
    });
    expect(writeText).toHaveBeenCalledExactlyOnceWith("latest memory only");
  });
});
