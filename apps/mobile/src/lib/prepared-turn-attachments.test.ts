import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  type ThreadPreparedTurn,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({
  query: vi.fn(),
  download: vi.fn(),
  persist: vi.fn(),
  remove: vi.fn(async () => {}),
  size: 4,
}));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  executeAtomQuery: h.query,
  squashAtomCommandFailure: () => new Error("Asset unavailable"),
}));
vi.mock("../state/atom-registry", () => ({ appAtomRegistry: { get: (value: unknown) => value } }));
vi.mock("../state/session", async () => {
  const Option = await import("effect/Option");
  return {
    environmentSession: {
      preparedConnectionValueAtom: () => Option.some({ httpBaseUrl: "https://remote.example" }),
    },
  };
});
vi.mock("../state/assets", () => ({ assetEnvironment: { createUrl: (input: unknown) => input } }));
vi.mock("./attachmentDownload", () => ({ downloadAttachmentForPreview: h.download }));
vi.mock("./composerImages", () => ({
  persistComposerAttachmentFile: h.persist,
  removePersistedComposerAttachmentFile: h.remove,
}));
vi.mock("expo-file-system", () => ({
  File: class {
    get size() {
      return h.size;
    }
  },
}));

import { loadPreparedTurnAttachments } from "./prepared-turn-attachments";
const environmentId = EnvironmentId.make("original-environment");
const image = {
  id: "original-image",
  type: "image" as const,
  name: "original.png",
  mimeType: "image/png",
  sizeBytes: 4,
};
const original = (attachments = [image]): ThreadPreparedTurn => ({
  recoveryId: CommandId.make("original-command"),
  projectId: ProjectId.make("original-project"),
  projectCwd: "/project",
  expectedCwd: "/project/worktree",
  providerIdentity: {
    driverKind: ProviderDriverKind.make("meerkat"),
    continuationKey: "original-provider",
  },
  phase: "blocked",
  setup: "finished",
  createdAt: "2026-10-05T10:00:00.000Z",
  updatedAt: "2026-10-05T10:00:00.000Z",
  command: {
    type: "thread.turn.start",
    commandId: CommandId.make("original-command"),
    threadId: ThreadId.make("original-thread"),
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: "2026-10-05T10:00:00.000Z",
    message: {
      messageId: MessageId.make("original-message"),
      role: "user",
      text: "Review the attached image",
      attachments,
    },
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  h.size = 4;
  h.query.mockResolvedValue({
    _tag: "Success",
    value: { relativeUrl: "/api/attachment/original?token=temporary" },
  });
  h.download.mockResolvedValue({ uri: "file:///cache/temporary.png", dispose: vi.fn() });
  h.persist.mockResolvedValue("file:///owned/original.png");
});

describe("prepared message owned attachment recovery", () => {
  it("resolves the exact environment asset and persists original bytes without a signed URL", async () => {
    const files = await loadPreparedTurnAttachments(
      environmentId,
      original(),
      new AbortController().signal,
    );
    expect(h.query.mock.calls[0]?.[1]).toEqual({
      environmentId,
      input: { resource: { _tag: "attachment", attachmentId: image.id, fileName: image.name } },
    });
    expect(h.download.mock.calls[0]?.[0].url).toBe(
      "https://remote.example/api/attachment/original?token=temporary",
    );
    expect(files).toEqual([
      { ...image, fileUri: "file:///owned/original.png", previewUri: "file:///owned/original.png" },
    ]);
    expect(JSON.stringify(files)).not.toContain("token=");
    expect(h.remove).not.toHaveBeenCalled();
  });

  it("removes partial and earlier owned copies when a later asset fails", async () => {
    h.query
      .mockResolvedValueOnce({
        _tag: "Success",
        value: { relativeUrl: "/api/attachment/original" },
      })
      .mockResolvedValueOnce({ _tag: "Failure" });
    const prepared = original([image, { ...image, id: "second-image" }]);
    await expect(
      loadPreparedTurnAttachments(environmentId, prepared, new AbortController().signal),
    ).rejects.toThrow("Asset unavailable");
    expect(h.remove).toHaveBeenCalledWith("file:///owned/original.png");
    expect(prepared.command.message.attachments).toHaveLength(2);
  });

  it("rejects a truncated saved image and removes its owned copy", async () => {
    h.size = 3;
    await expect(
      loadPreparedTurnAttachments(environmentId, original(), new AbortController().signal),
    ).rejects.toThrow("incomplete");
    expect(h.remove).toHaveBeenCalledWith("file:///owned/original.png");
    const temporary = await h.download.mock.results[0]?.value;
    expect(temporary.dispose).toHaveBeenCalledOnce();
  });

  it("cancels after file persistence without adopting a cache or owned copy", async () => {
    const abort = new AbortController();
    h.persist.mockImplementationOnce(async () => {
      abort.abort();
      return "file:///owned/cancelled.png";
    });
    await expect(
      loadPreparedTurnAttachments(environmentId, original(), abort.signal),
    ).rejects.toThrow("cancelled");
    expect(h.remove).toHaveBeenCalledWith("file:///owned/cancelled.png");
  });
});
