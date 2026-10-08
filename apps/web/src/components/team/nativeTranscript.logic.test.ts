import type { MeerkatSavedTranscript } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  mergeSavedTranscriptPages,
  savedMessageView,
  savedTranscriptText,
} from "./nativeTranscript.logic";

const image = {
  type: "image",
  source: "blob",
  blob_id: `sha256:${"a".repeat(64)}`,
  media_type: "image/png",
};
function page(overrides: Partial<MeerkatSavedTranscript> = {}): MeerkatSavedTranscript {
  return {
    sessionId: "session-a",
    storeRevision: "4",
    messages: [{ offset: 9, message: { role: "user", content: "Latest" } }],
    totalMessages: 10,
    exhausted: false,
    nextBefore: 9,
    ...overrides,
  };
}

describe("native saved message presentation", () => {
  it("preserves committed user content and distinguishes runtime context from user authorship", () => {
    expect(
      savedMessageView(
        { role: "user", content: "Initial task", created_at: "2026-09-26T01:00:00Z" },
        "Reviewer",
      ),
    ).toEqual({
      user: true,
      label: "Input",
      timestamp: "2026-09-26T01:00:00Z",
      parts: [{ kind: "text", text: "Initial task" }],
    });
    expect(
      savedMessageView(
        { role: "user", content: [{ type: "text", text: "Look" }, image] },
        "Reviewer",
      )?.parts,
    ).toEqual([
      { kind: "text", text: "Look" },
      { kind: "image", image },
    ]);
    expect(
      savedMessageView(
        { role: "user", transcript_role: "compaction_summary", content: "Summary" },
        "Reviewer",
      ),
    ).toMatchObject({ user: false, label: "Conversation summary" });
    expect(
      savedMessageView(
        { role: "user", transcript_role: "injected_context", content: "Repo context" },
        "Reviewer",
      ),
    ).toMatchObject({ user: false, label: "Attached context" });
    expect(
      savedMessageView({ role: "system", content: "Private system instruction" }, "Reviewer"),
    ).toBeNull();
  });
  it("keeps native assistant block order and tool arguments without treating metadata as prose", () => {
    const view = savedMessageView(
      {
        role: "block_assistant",
        blocks: [
          {
            block_type: "reasoning",
            data: { text: "Visible reasoning", meta: { encrypted: "not prose" } },
          },
          { block_type: "text", data: { text: "Checking", meta: { signature: "not prose" } } },
          {
            block_type: "tool_use",
            data: { id: "call-1", name: "read_file", args: { path: "README.md" } },
          },
          { block_type: "transcript", data: { text: "Final answer", source: "audio" } },
        ],
      },
      "Reviewer",
    );
    expect(view).toMatchObject({
      user: false,
      label: "Reviewer",
      parts: [
        { kind: "reasoning", text: "Visible reasoning" },
        { kind: "text", text: "Checking" },
        { kind: "tool", label: "read_file", value: { path: "README.md" }, error: false },
        { kind: "text", text: "Final answer" },
      ],
    });
  });
  it("preserves tool errors and only renders durable supported blob image references", () => {
    const view = savedMessageView(
      {
        role: "tool_results",
        results: [
          {
            tool_use_id: "call-1",
            is_error: true,
            content: [{ type: "text", text: "Failed" }, image],
          },
        ],
      },
      "Reviewer",
    );
    expect(view?.parts).toEqual([
      {
        kind: "tool",
        label: "Tool error",
        value: [{ type: "text", text: "Failed" }, image],
        error: true,
      },
      { kind: "image", image },
    ]);
    expect(
      savedMessageView(
        { role: "user", content: [{ ...image, blob_id: "../../other-session" }] },
        "Reviewer",
      )?.parts[0]?.kind,
    ).toBe("details");
  });
  it("copies saved conversation text without including the system prompt or image bytes", () => {
    const transcript = page({
      messages: [
        { offset: 0, message: { role: "system", content: "Hidden" } },
        { offset: 1, message: { role: "user", content: [{ type: "text", text: "Task" }, image] } },
        {
          offset: 2,
          message: {
            role: "block_assistant",
            blocks: [{ block_type: "text", data: { text: "Answer" } }],
          },
        },
      ],
    });
    expect(savedTranscriptText(transcript, "Reviewer")).toBe(
      "Input: Task\n\n[Image]\n\nReviewer: Answer",
    );
  });
});

describe("saved transcript generated images", () => {
  it("renders generated assistant images from the native Image block BlobRef", () => {
    expect(
      savedMessageView(
        {
          role: "block_assistant",
          blocks: [
            {
              block_type: "image",
              data: {
                image_id: "image-1",
                blob_ref: { blob_id: image.blob_id, media_type: image.media_type },
                media_type: "image/png",
                width: 128,
                height: 96,
                revised_prompt: { status: "not_provided" },
                meta: {},
              },
            },
          ],
        },
        "Reviewer",
      )?.parts,
    ).toEqual([{ kind: "image", image }]);
  });
});

describe("saved transcript pagination", () => {
  it("merges native offsets only within one committed revision", () => {
    const current = page();
    const older = page({
      messages: [
        { offset: 2, message: { role: "user", content: "Initial task" } },
        { offset: 9, message: { role: "user", content: "Overlap" } },
      ],
      nextBefore: 2,
    });
    expect(mergeSavedTranscriptPages(current, older)).toMatchObject({
      nextBefore: 2,
      messages: [
        { offset: 2, message: { content: "Initial task" } },
        { offset: 9, message: { content: "Latest" } },
      ],
    });
    expect(() => mergeSavedTranscriptPages(current, { ...older, storeRevision: "5" })).toThrow(
      "changed",
    );
    expect(() => mergeSavedTranscriptPages(current, { ...older, sessionId: "different" })).toThrow(
      "changed",
    );
  });
  it("stops nonadvancing cursors but accepts an exhausted empty final page", () => {
    expect(() => mergeSavedTranscriptPages(page(), page({ messages: [] }))).toThrow(
      "stopped advancing",
    );
    expect(() =>
      mergeSavedTranscriptPages(page(), page({ messages: [], nextBefore: undefined })),
    ).toThrow("stopped advancing");
    expect(
      mergeSavedTranscriptPages(
        page(),
        page({ messages: [], exhausted: true, nextBefore: undefined }),
      ),
    ).toMatchObject({ exhausted: true, messages: [{ offset: 9 }] });
  });
});
