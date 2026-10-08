import {
  CommandId,
  ComposerContextId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ThreadPreparedTurn,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import type { ComposerDraft } from "./use-composer-drafts";
import {
  editPreparedMessage,
  preparedTurnDraft,
  retryPreparedMessage,
} from "./prepared-turn-recovery";

function prepared(
  message: Partial<ThreadPreparedTurn["command"]["message"]> = {},
): ThreadPreparedTurn {
  return {
    recoveryId: CommandId.make("original-command"),
    projectId: ProjectId.make("project"),
    projectCwd: "/project",
    expectedCwd: "/project/worktree",
    phase: "blocked",
    setup: "finished",
    providerIdentity: {
      driverKind: ProviderDriverKind.make("meerkat"),
      continuationKey: "original-provider",
    },
    createdAt: "2026-10-05T10:00:00.000Z",
    updatedAt: "2026-10-05T10:00:00.000Z",
    command: {
      type: "thread.turn.start",
      commandId: CommandId.make("original-command"),
      threadId: ThreadId.make("thread"),
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: "2026-10-05T10:00:00.000Z",
      modelSelection: {
        instanceId: ProviderInstanceId.make("meerkat-account"),
        model: "original-model",
        options: [{ id: "reasoning_effort", value: "high" }],
      },
      message: {
        messageId: MessageId.make("original-message"),
        role: "user",
        text: "Review this",
        attachments: [],
        ...message,
      },
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function editor(original = prepared()) {
  let live = original;
  let draft: ComposerDraft = { text: "", attachments: [] };
  let validScope = true;
  const release = vi.fn(async (_prepared: ThreadPreparedTurn) => {
    live = { ...live, phase: "released" };
  });
  const cleanup = vi.fn();
  const current = () => {
    if (!validScope) throw new Error("Scope changed");
    return { prepared: live, setupActive: false };
  };
  const restore = vi.fn(async (restored: ComposerDraft, validate: () => void) => {
    validate();
    draft = restored;
  });
  const input = {
    current,
    release,
    cleanup,
    restore,
    loadAttachments: vi.fn(async () => []),
    ensureUnchangedDraft: () => {
      if (draft.text || draft.attachments.length) throw new Error("Draft changed");
    },
  };
  return {
    input,
    get live() {
      return live;
    },
    get draft() {
      return draft;
    },
    changeDraft: () => {
      draft = { text: "New typing", attachments: [] };
    },
    leave: () => {
      validScope = false;
    },
  };
}

describe("prepared mobile message recovery", () => {
  it("retries only the original receipt ID and checkout, with explicit interrupted setup consent", async () => {
    const original = { ...prepared(), setup: "sync_running" as const };
    const retry = vi.fn(async () => {});
    const access = { current: () => ({ prepared: original, setupActive: false }) };
    await expect(retryPreparedMessage(access, false, retry)).rejects.toThrow("Confirm");
    expect(retry).not.toHaveBeenCalled();
    await retryPreparedMessage(access, true, retry);
    expect(retry).toHaveBeenCalledWith({
      threadId: original.command.threadId,
      recoveryId: original.recoveryId,
      expectedCwd: "/project/worktree",
      continueAfterInterruptedSetup: true,
    });
    expect(original.command.modelSelection?.options).toEqual([
      { id: "reasoning_effort", value: "high" },
    ]);
  });

  it("does not retry a released request or interrupt a running synchronous setup", async () => {
    const retry = vi.fn(async () => {});
    for (const state of [
      { prepared: { ...prepared(), phase: "released" as const }, setupActive: false },
      { prepared: { ...prepared(), setup: "sync_running" as const }, setupActive: true },
    ])
      await expect(retryPreparedMessage({ current: () => state }, true, retry)).rejects.toThrow(
        "not ready",
      );
    expect(retry).not.toHaveBeenCalled();
  });

  it("preserves queued edits before retry and rechecks recovery authority afterwards", async () => {
    const h = editor();
    const retry = vi.fn(async () => {});
    await expect(
      retryPreparedMessage(h.input, false, retry, async () => {
        throw new Error("Queued edits could not persist");
      }),
    ).rejects.toThrow("Queued edits could not persist");
    expect(retry).not.toHaveBeenCalled();
    await expect(
      retryPreparedMessage(h.input, false, retry, async () => {
        h.leave();
      }),
    ).rejects.toThrow("Scope changed");
    expect(retry).not.toHaveBeenCalled();
  });

  it("releases before restoring exact text, context, owned images, model and reasoning", async () => {
    const image = {
      type: "image" as const,
      id: "image",
      name: "original.png",
      mimeType: "image/png" as const,
      sizeBytes: 3,
    };
    const context = {
      version: 1 as const,
      records: [
        {
          version: 1 as const,
          kind: "image" as const,
          contextId: ComposerContextId.make("image-original"),
          label: "Original",
          attachmentId: "image",
          name: image.name,
          mimeType: image.mimeType,
          sizeBytes: image.sizeBytes,
        },
      ],
    };
    const original = prepared({ attachments: [image], context });
    const h = editor(original);
    const attachments = [
      { ...image, fileUri: "file:///owned/original.png", previewUri: "file:///owned/original.png" },
    ];
    await editPreparedMessage({
      ...h.input,
      loadAttachments: async () => attachments,
      restore: async (draft, validate) => {
        expect(h.live.phase).toBe("released");
        await h.input.restore(draft, validate);
      },
    });
    expect(h.draft).toEqual({
      text: original.command.message.text,
      context,
      attachments,
      modelSelection: original.command.modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
    });
    expect(h.input.release).toHaveBeenCalledWith(original);
    expect(h.live.command).toBe(original.command);
    expect(h.input.cleanup).toHaveBeenCalledWith(attachments);
  });

  it("refuses an occupied draft before downloading or releasing", async () => {
    const h = editor();
    h.changeDraft();
    await expect(editPreparedMessage(h.input)).rejects.toThrow("Draft changed");
    expect(h.input.loadAttachments).not.toHaveBeenCalled();
    expect(h.input.release).not.toHaveBeenCalled();
  });

  it("rechecks typing and scope after a download", async () => {
    for (const change of ["typing", "scope"] as const) {
      const h = editor();
      const download = deferred();
      const result = editPreparedMessage({
        ...h.input,
        loadAttachments: async () => {
          await download.promise;
          return [];
        },
      });
      if (change === "typing") h.changeDraft();
      else h.leave();
      download.resolve();
      await expect(result).rejects.toThrow(change === "typing" ? "Draft changed" : "Scope changed");
      expect(h.input.release).not.toHaveBeenCalled();
      expect(h.input.restore).not.toHaveBeenCalled();
    }
  });

  it("keeps the released original when typing wins a release or hydration race", async () => {
    for (const during of ["release", "hydration"]) {
      const h = editor();
      await expect(
        editPreparedMessage({
          ...h.input,
          release: async (original) => {
            await h.input.release(original);
            if (during === "release") h.changeDraft();
          },
          restore: async (draft, validate) => {
            if (during === "hydration") h.changeDraft();
            await h.input.restore(draft, validate);
          },
        }),
      ).rejects.toThrow("Draft changed");
      expect(h.draft.text).toBe("New typing");
      expect(h.live.phase).toBe("released");
      expect(h.live.command.message.text).toBe("Review this");
    }
  });

  it("leaves the composer untouched after release failure, allowing the same recovery again", async () => {
    const h = editor();
    await expect(
      editPreparedMessage({
        ...h.input,
        release: async () => {
          throw new Error("Offline");
        },
      }),
    ).rejects.toThrow("Offline");
    expect(h.input.restore).not.toHaveBeenCalled();
    expect(h.live.phase).toBe("blocked");
    await editPreparedMessage(h.input);
    expect(h.draft.text).toBe("Review this");
  });

  it("retains published local bytes after persistence fails and restores the released original after restart", async () => {
    const h = editor();
    await expect(
      editPreparedMessage({
        ...h.input,
        restore: async (draft, validate) => {
          await h.input.restore(draft, validate);
          throw new Error("Disk full");
        },
      }),
    ).rejects.toThrow("Disk full");
    expect(h.draft.text).toBe("Review this");
    const restarted = editor(h.live);
    await editPreparedMessage(restarted.input);
    expect(restarted.input.release).not.toHaveBeenCalled();
    expect(restarted.draft.modelSelection).toEqual(h.live.command.modelSelection);
  });

  it("blocks unsupported attachment/context metadata before release without affecting exact Retry", async () => {
    const original = prepared({
      context: {
        version: 1,
        records: [
          {
            version: 1,
            kind: "future-context",
            contextId: ComposerContextId.make("future-1"),
            label: "Future",
            payload: { original: true },
          },
        ],
      },
    });
    const h = editor(original);
    await expect(editPreparedMessage(h.input)).rejects.toThrow("cannot edit yet");
    expect(h.input.release).not.toHaveBeenCalled();
    const retry = vi.fn(async () => {});
    await retryPreparedMessage(h.input, false, retry);
    expect(retry).toHaveBeenCalledOnce();
  });

  it("does not silently restore only a subset of original attachments", () => {
    const original = prepared({
      attachments: [
        { type: "file", id: "file", name: "notes.txt", mimeType: "text/plain", sizeBytes: 4 },
      ],
    });
    expect(() => preparedTurnDraft(original, [])).toThrow("incomplete");
  });

  it("keeps unsupported image formats and capture metadata retryable", async () => {
    for (const attachment of [
      {
        type: "image" as const,
        id: "svg",
        name: "diagram.svg",
        mimeType: "image/svg+xml",
        sizeBytes: 4,
      },
      {
        type: "image" as const,
        id: "capture",
        name: "screen.png",
        mimeType: "image/png",
        sizeBytes: 4,
        source: {
          kind: "snap-shot" as const,
          capturedAt: "2026-10-05T10:00:00.000Z",
          appName: "Editor",
          windowTitle: "Original",
        },
      },
    ]) {
      const h = editor(prepared({ attachments: [attachment] }));
      await expect(editPreparedMessage(h.input)).rejects.toThrow("Retry the original message");
      expect(h.input.release).not.toHaveBeenCalled();
      const retry = vi.fn(async () => {});
      await retryPreparedMessage(h.input, false, retry);
      expect(retry).toHaveBeenCalledOnce();
    }
  });
});
