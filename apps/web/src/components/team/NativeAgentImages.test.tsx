import {
  EnvironmentId,
  MeerkatMediaError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type MeerkatImageRead,
  type MeerkatImageRef,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import {
  act,
  useLayoutEffect,
  type ButtonHTMLAttributes,
  type ReactElement,
  type ReactNode,
} from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ExpandedImagePreview } from "../chat/ExpandedImagePreview";
import type { EnvironmentQueryView } from "../../state/query";

const mediaRead = vi.hoisted(() => vi.fn());
const mediaUpload = vi.hoisted(() => vi.fn());
vi.mock("@t3tools/client-runtime/state/meerkatMedia", () => ({
  createMeerkatMediaAtoms: () => ({ imageRead: mediaRead, imageUpload: "imageUpload" }),
}));
vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../../state/query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/query")>()),
  useEnvironmentQuery: () => queryState,
}));
vi.mock("../../state/meerkatTeam", () => ({
  meerkatTeamEnvironment: {},
  useVisibleTeamRefresh: () => {},
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mediaUpload }));
vi.mock("../ui/button", async () => {
  const { cloneElement } = await import("react");
  return {
    Button: ({
      render,
      children,
      ...props
    }: ButtonHTMLAttributes<HTMLButtonElement> & {
      render?: ReactElement<{ children?: ReactNode }>;
    }) => (render ? cloneElement(render, {}, children) : <button {...props}>{children}</button>),
  };
});
vi.mock("../chat/ExpandedImageDialog", () => ({
  ExpandedImageDialog: ({
    preview,
    onClose,
  }: {
    preview: ExpandedImagePreview;
    onClose: () => void;
  }) => (
    <div role="dialog">
      <img
        src={preview.images[preview.index]?.src ?? undefined}
        alt={preview.images[preview.index]?.name}
      />
      <button onClick={onClose}>Close preview</button>
    </div>
  ),
}));

import {
  NativeAgentImages,
  NativeImageDraftRecovery,
  useMeerkatImageAttachments,
  type NativeMediaScope,
} from "./NativeAgentImages";
import { nativeImageDraftStorageKey } from "./nativeImageDraftStore";

const image: MeerkatImageRef = {
  type: "image",
  source: "blob",
  media_type: "image/png",
  blob_id: `sha256:${"a".repeat(64)}`,
};
const scope: NativeMediaScope = {
  environmentId: EnvironmentId.make("environment"),
  projectId: ProjectId.make("project"),
  instanceId: ProviderInstanceId.make("meerkat"),
  agentRef: "reviewer",
};
let queryState: EnvironmentQueryView<MeerkatImageRead>;
let renderer: ReactTestRenderer | undefined;
const render = (target = scope, images: MeerkatImageRef[] = [image]) => {
  act(() => {
    const element = <NativeAgentImages scope={target} images={images} />;
    if (renderer) renderer.update(element);
    else renderer = create(element);
  });
};
const openPreview = () =>
  act(() => {
    renderer!.root.findByProps({ "aria-label": "Preview conversation image" }).props.onClick();
  });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  queryState = {
    data: {
      mobId: "mob",
      blob: { blobId: image.blob_id, mediaType: "image/png", size: 4 },
      dataBase64: "aW1hZ2U=",
    },
    dataUpdatedAt: 1,
    isPending: false,
    isSuccess: true,
    error: null,
    refresh: () => {},
  };
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("native conversation image preview", () => {
  it("opens the donor viewer with the loaded image and closes it without removing the thumbnail", () => {
    render();
    expect(renderer!.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
    openPreview();

    const dialog = renderer!.root.findByProps({ role: "dialog" });
    expect(dialog.findByType("img").props.src).toBe("data:image/png;base64,aW1hZ2U=");
    expect(dialog.findByType("img").props.alt).toBe("image-aaaaaaaaaaaa.png");
    expect(renderer!.root.findByType("a").props.href).toBe(dialog.findByType("img").props.src);
    expect(renderer!.root.findByType("a").props.download).toBe("image-aaaaaaaaaaaa.png");
    act(() => dialog.findByType("button").props.onClick());

    expect(renderer!.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
    expect(renderer!.root.findAllByType("img")).toHaveLength(1);
    expect(mediaRead).toHaveBeenLastCalledWith({
      environmentId: scope.environmentId,
      input: {
        projectId: scope.projectId,
        instanceId: scope.instanceId,
        agentRef: scope.agentRef,
        blobId: image.blob_id,
      },
    });
  });

  it.each([
    { ...scope, agentRef: "builder" },
    { ...scope, environmentId: EnvironmentId.make("other-environment") },
    { ...scope, projectId: ProjectId.make("other-project") },
    { ...scope, instanceId: ProviderInstanceId.make("other-instance") },
    { ...scope, threadId: ThreadId.make("thread") },
  ])("closes an open preview when its conversation scope changes (%o)", (target) => {
    render();
    openPreview();
    render(target);
    expect(renderer!.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
    const { environmentId, ...input } = target;
    expect(mediaRead).toHaveBeenLastCalledWith({
      environmentId,
      input: { ...input, blobId: image.blob_id },
    });
  });

  it("does not offer a preview or download while image data is unavailable", () => {
    queryState = { ...queryState, data: null, isPending: true, isSuccess: false };
    render();
    expect(renderer!.root.findAllByType("button")).toHaveLength(0);
    expect(renderer!.root.findAllByType("a")).toHaveLength(0);
    queryState = { ...queryState, isPending: false, error: "Image unavailable" };
    render();
    expect(renderer!.root.findAllByType("button")).toHaveLength(0);
    expect(renderer!.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
  });
});

describe("native image attachment upload", () => {
  let attachments: ReturnType<typeof useMeerkatImageAttachments>;
  let storage: Map<string, string>;
  const storageKey = nativeImageDraftStorageKey(scope, "stable-reviewer");
  const legacyStorageKey = `meerkat-image-draft:${JSON.stringify(scope)}`;
  const uploadFile = new File(["image"], "screenshot.jpg", { type: "image/jpeg" });

  function AttachmentHarness({
    target = scope,
    draftKey = "stable-reviewer",
  }: {
    target?: NativeMediaScope;
    draftKey?: string;
  }) {
    const current = useMeerkatImageAttachments(target, draftKey);
    useLayoutEffect(() => {
      attachments = current;
    });
    return <NativeImageDraftRecovery attachments={current} />;
  }

  beforeEach(() => {
    mediaUpload.mockReset();
    storage = new Map();
    const session = new Map([[legacyStorageKey, JSON.stringify([image])]]);
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => session.get(key) ?? null,
      setItem: (key: string, value: string) => session.set(key, value),
      removeItem: (key: string) => session.delete(key),
    });
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    vi.stubGlobal(
      "FileReader",
      class extends EventTarget {
        result: string | null = null;
        readAsDataURL() {
          this.result = "data:image/jpeg;base64,aW1hZ2U=";
          this.dispatchEvent(new Event("load"));
        }
      },
    );
    act(() => {
      renderer = create(<AttachmentHarness />);
    });
  });

  it("keeps old scope images in recovery when a canonical target first opens", () => {
    const oldBytes = JSON.stringify([image]);
    sessionStorage.setItem(legacyStorageKey, oldBytes);
    const canonical = `native-agent-draft:v2:${JSON.stringify([scope.environmentId, scope.projectId, scope.instanceId, "native-agent", "worker-a"])}`;
    act(() => renderer!.update(<AttachmentHarness draftKey={canonical} />));
    expect(attachments.images).toEqual([]);
    expect(sessionStorage.getItem(legacyStorageKey)).toBe(oldBytes);
    expect(storage.get(nativeImageDraftStorageKey(scope, canonical))).toBeUndefined();
    expect(mediaUpload).not.toHaveBeenCalled();
  });

  it("shows the native rejection, preserves attached images, and accepts a successful retry", async () => {
    const message = "Image bytes do not match the declared media type";
    mediaUpload.mockResolvedValueOnce({
      _tag: "Failure",
      cause: Cause.fail(new MeerkatMediaError({ projectId: scope.projectId, message })),
    });

    await act(() => attachments.addFiles([uploadFile]));

    expect(attachments.error).toBe(message);
    expect(attachments.uploading).toBe(false);
    expect(attachments.images).toEqual([image]);
    expect(JSON.parse(storage.get(storageKey)!)).toEqual([image]);

    const uploadedImage: MeerkatImageRef = {
      type: "image",
      source: "blob",
      blob_id: `sha256:${"b".repeat(64)}`,
      media_type: "image/jpeg",
    };
    mediaUpload.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        mobId: "mob",
        blob: { blobId: uploadedImage.blob_id, mediaType: uploadedImage.media_type, size: 5 },
      },
    });

    await act(() => attachments.addFiles([uploadFile]));

    expect(attachments.error).toBeNull();
    expect(attachments.uploading).toBe(false);
    expect(attachments.images).toEqual([image, uploadedImage]);
    expect(JSON.parse(storage.get(storageKey)!)).toEqual([image, uploadedImage]);
    expect(mediaUpload).toHaveBeenCalledTimes(2);
    expect(mediaUpload).toHaveBeenLastCalledWith({
      environmentId: scope.environmentId,
      input: {
        projectId: scope.projectId,
        instanceId: scope.instanceId,
        agentRef: scope.agentRef,
        mediaType: "image/jpeg",
        dataBase64: "aW1hZ2U=",
      },
    });
  });

  it("blocks new uploads and payload capture until the saved images are explicitly recovered", async () => {
    act(() => renderer!.unmount());
    let fail = true;
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => {
        if (key === storageKey && fail) throw new Error("unavailable");
        return storage.get(key) ?? null;
      },
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    act(() => {
      renderer = create(<AttachmentHarness />);
    });
    fail = false;
    await act(() => attachments.addFiles([uploadFile]));
    expect(mediaUpload).not.toHaveBeenCalled();
    expect(attachments.readFailed).toBe(true);
    expect(attachments.readForSend()).toBeNull();
    act(() => {
      attachments.remove(image.blob_id);
    });
    expect(JSON.parse(storage.get(storageKey)!)).toEqual([image]);
    act(() => renderer!.root.findByType("button").props.onClick());
    expect(attachments.readFailed).toBe(false);
    let recovered;
    act(() => {
      recovered = attachments.readForSend();
    });
    expect(recovered).toEqual([image]);
    expect(renderer!.root.findAllByType("button")).toHaveLength(0);
  });

  it("reacquires unavailable browser storage without reading the next conversation's key", () => {
    act(() => renderer!.unmount());
    vi.stubGlobal("localStorage", undefined);
    act(() => {
      renderer = create(<AttachmentHarness />);
    });
    expect(attachments.readFailed).toBe(true);
    const retryOriginal = attachments.retryRead;
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    act(() => renderer!.update(<AttachmentHarness draftKey="other-agent" />));
    expect(attachments.images).toEqual([]);
    act(() => {
      expect(retryOriginal()).toBe(true);
    });
    expect(attachments.images).toEqual([]);
    act(() => renderer!.update(<AttachmentHarness />));
    expect(attachments.images).toEqual([image]);
  });

  it("shows the standard request fallback when a failure has no readable message", async () => {
    mediaUpload.mockResolvedValueOnce({ _tag: "Failure", cause: Cause.fail({ code: "unknown" }) });

    await act(() => attachments.addFiles([uploadFile]));

    expect(attachments.error).toBe("The environment request failed.");
    expect(attachments.uploading).toBe(false);
    expect(attachments.images).toEqual([image]);
  });

  it("keeps image refs through a new native incarnation and a cold browser session", () => {
    act(() => renderer?.unmount());
    renderer = undefined;
    vi.stubGlobal("sessionStorage", {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    });
    act(() => {
      renderer = create(<AttachmentHarness target={{ ...scope, agentRef: "new-incarnation" }} />);
    });
    expect(attachments.images).toEqual([image]);
    act(() => {
      attachments.clear();
    });
    expect(JSON.parse(storage.get(storageKey)!)).toEqual([]);
  });

  it("does not move a late upload into the next conversation", async () => {
    const uploadedImage: MeerkatImageRef = { ...image, blob_id: `sha256:${"b".repeat(64)}` };
    let finishUpload!: (value: unknown) => void;
    mediaUpload.mockReturnValueOnce(
      new Promise((resolve) => {
        finishUpload = resolve;
      }),
    );
    let pending!: Promise<void>;
    await act(async () => {
      pending = attachments.addFiles([uploadFile]);
      await Promise.resolve();
    });
    act(() => {
      renderer!.update(
        <AttachmentHarness target={{ ...scope, agentRef: "other-agent" }} draftKey="other-agent" />,
      );
    });
    expect(attachments.images).toEqual([]);
    expect(attachments.uploading).toBe(false);
    await act(async () => {
      finishUpload({
        _tag: "Success",
        value: {
          mobId: "mob",
          blob: { blobId: uploadedImage.blob_id, mediaType: uploadedImage.media_type, size: 5 },
        },
      });
      await pending;
    });
    expect(attachments.images).toEqual([]);
    expect(JSON.parse(storage.get(storageKey)!)).toEqual([image, uploadedImage]);
    act(() => renderer!.update(<AttachmentHarness />));
    expect(attachments.images).toEqual([image, uploadedImage]);
  });
  it("an earlier acknowledgement preserves images added to the current draft later", async () => {
    const laterImage: MeerkatImageRef = { ...image, blob_id: `sha256:${"c".repeat(64)}` };
    mediaUpload.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        mobId: "mob",
        blob: { blobId: laterImage.blob_id, mediaType: laterImage.media_type, size: 5 },
      },
    });
    await act(() => attachments.addFiles([uploadFile]));
    act(() => {
      attachments.clearAcknowledged([image]);
    });
    expect(attachments.images).toEqual([laterImage]);
    expect(JSON.parse(storage.get(storageKey)!)).toEqual([laterImage]);
  });
});
