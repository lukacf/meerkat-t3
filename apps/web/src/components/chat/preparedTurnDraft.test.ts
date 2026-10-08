import {
  CommandId,
  ComposerContextId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  type ThreadPreparedTurn,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { buildMessageContext } from "../../lib/composerContextRecords";
import {
  formatInlineContextReference,
  toKindScopedComposerContextId,
} from "../../lib/composerContextReferences";
import { preparedTurnDraft, preparedTurnImagesPersisted } from "./preparedTurnDraft";

function prepared(): ThreadPreparedTurn {
  return {
    recoveryId: CommandId.make("original"),
    projectId: ProjectId.make("project"),
    projectCwd: "/project",
    providerIdentity: {
      driverKind: ProviderDriverKind.make("meerkat"),
      continuationKey: "fixture-meerkat",
    },
    expectedCwd: "/original-checkout",
    phase: "released",
    setup: "finished",
    createdAt: "2026-10-04T12:00:00.000Z",
    updatedAt: "2026-10-04T12:01:00.000Z",
    command: {
      type: "thread.turn.start",
      commandId: CommandId.make("original"),
      threadId: ThreadId.make("thread"),
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: "2026-10-04T12:00:00.000Z",
      message: {
        messageId: MessageId.make("message"),
        role: "user",
        text: "Original",
        attachments: [],
      },
    },
  };
}
const environmentId = EnvironmentId.make("original-environment");
describe("prepared-turn draft reconstruction", () => {
  it("preserves image bytes, durable file references, and terminal/review context without changing the saved command", async () => {
    const image = new File(["image"], "test.png", { type: "image/png" });
    const file = new File(["notes"], "notes.txt", { type: "text/plain" });
    const context = buildMessageContext({
      attachments: [
        {
          attachment: {
            id: "image-local",
            type: "image",
            name: "test.png",
            mimeType: "image/png",
            sizeBytes: image.size,
            file: image,
            previewUrl: "data:image/png;base64,aW1hZ2U=",
          },
          attachmentId: "image-asset",
        },
        {
          attachment: {
            id: "file-local",
            type: "file",
            name: "notes.txt",
            mimeType: "text/plain",
            sizeBytes: file.size,
            file,
          },
          attachmentId: "file-asset",
        },
      ],
      terminalContexts: [
        {
          id: "terminal-local",
          threadId: ThreadId.make("thread"),
          terminalId: "terminal-1",
          terminalLabel: "Build",
          lineStart: 1,
          lineEnd: 2,
          text: "original output",
          createdAt: "2026-10-04T12:00:00.000Z",
        },
      ],
      reviewComments: [
        {
          id: "review-local",
          sectionId: "diff",
          sectionTitle: "Changes",
          filePath: "src/app.ts",
          startIndex: 0,
          endIndex: 1,
          rangeLabel: "+1",
          text: "Check this",
          diff: "+original",
        },
      ],
      previewAnnotations: [],
    });
    const original = prepared();
    const message = {
      ...original.command.message,
      text: `Review ${formatInlineContextReference({ contextId: toKindScopedComposerContextId("terminal", "terminal-local"), kind: "terminal", label: "Build" })}`,
      attachments: [
        {
          type: "image" as const,
          id: "image-asset",
          name: image.name,
          mimeType: image.type,
          sizeBytes: image.size,
        },
        {
          type: "file" as const,
          id: "file-asset",
          name: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
        },
      ],
      ...(context ? { context } : {}),
    };
    const recovery = { ...original, command: { ...original.command, message } };
    const before = JSON.stringify(recovery);
    const restored = preparedTurnDraft({
      prepared: recovery,
      environmentId,
      files: [image, file],
      imageDataUrls: new Map([[0, "data:image/png;base64,aW1hZ2U="]]),
    });
    expect(restored.prompt).toBe(message.text);
    expect(await restored.images[0]!.file.text()).toBe("image");
    expect(restored.persistedImages[0]?.dataUrl).toBe("data:image/png;base64,aW1hZ2U=");
    expect(restored.files[0]).toMatchObject({
      uploadedAttachmentId: "file-asset",
      uploadEnvironmentId: environmentId,
    });
    expect(restored.terminalContexts[0]).toMatchObject({
      text: "original output",
      threadId: "thread",
    });
    expect(restored.reviewComments[0]).toMatchObject({ text: "Check this", diff: "+original" });
    expect(JSON.stringify(recovery)).toBe(before);
  });
  it("fails before release when attachment bytes or image persistence data are unavailable", () => {
    const original = prepared();
    const recovery = {
      ...original,
      command: {
        ...original.command,
        message: {
          ...original.command.message,
          attachments: [
            {
              type: "image" as const,
              id: "asset",
              name: "image.png",
              mimeType: "image/png",
              sizeBytes: 1,
            },
          ],
        },
      },
    };
    expect(() =>
      preparedTurnDraft({ prepared: recovery, environmentId, files: [], imageDataUrls: new Map() }),
    ).toThrow("incomplete");
    expect(() =>
      preparedTurnDraft({
        prepared: recovery,
        environmentId,
        files: [new File(["x"], "image.png")],
        imageDataUrls: new Map(),
      }),
    ).toThrow("could not be loaded");
  });
  it.each([
    { kind: "skill" as const, name: "review" },
    { kind: "mention" as const, path: "src/app.ts" },
  ])("refuses to edit a saved $kind record that the composer cannot restore", (record) => {
    const original = prepared();
    const contextId = ComposerContextId.make("original-context");
    const recovery: ThreadPreparedTurn = {
      ...original,
      command: {
        ...original.command,
        message: {
          ...original.command.message,
          text: formatInlineContextReference({ contextId, kind: record.kind, label: "Original" }),
          context: {
            version: 1,
            records: [{ ...record, version: 1, contextId, label: "Original" }],
          },
        },
      },
    };
    const before = JSON.stringify(recovery);
    expect(() =>
      preparedTurnDraft({ prepared: recovery, environmentId, files: [], imageDataUrls: new Map() }),
    ).toThrow("Retry the original message to preserve it");
    expect(JSON.stringify(recovery)).toBe(before);
  });
  it("rejects a partial persisted image snapshot after an image save failure", () => {
    const image = {
      id: "saved-image",
      name: "image.png",
      mimeType: "image/png",
      sizeBytes: 1,
      dataUrl: "data:image/png;base64,eA==",
    };
    expect(preparedTurnImagesPersisted([image], [])).toBe(false);
    expect(
      preparedTurnImagesPersisted([image], [{ ...image, dataUrl: "data:image/png;base64,eQ==" }]),
    ).toBe(false);
    expect(preparedTurnImagesPersisted([image], [image])).toBe(true);
    expect(preparedTurnImagesPersisted([], [])).toBe(true);
  });
});
