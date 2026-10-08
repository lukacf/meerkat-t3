import type { MeerkatImageRef, MeerkatSavedTranscript } from "@t3tools/contracts";
import { nativePeerNotices, type NativePeerMessage } from "./nativePeerMessage.logic";

type JsonRecord = Record<string, unknown>;
export type SavedMessagePart =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "image"; image: MeerkatImageRef }
  | { kind: "peer"; label: string; value: unknown; peer: NativePeerMessage }
  | { kind: "tool"; label: string; value: unknown; error: boolean }
  | { kind: "details"; label: string; value: unknown };
export type SavedMessageView = {
  label: string;
  user: boolean;
  timestamp?: string;
  parts: SavedMessagePart[];
};

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function contentParts(content: unknown): SavedMessagePart[] {
  if (typeof content === "string") return [{ kind: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.flatMap((value): SavedMessagePart[] => {
    const block = record(value);
    if (!block) return [];
    if (block.type === "text" && typeof block.text === "string")
      return [{ kind: "text", text: block.text }];
    if (
      block.type === "image" &&
      block.source === "blob" &&
      typeof block.blob_id === "string" &&
      /^sha256:[a-f0-9]{64}$/.test(block.blob_id) &&
      typeof block.media_type === "string" &&
      ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(block.media_type)
    )
      return [
        {
          kind: "image",
          image: {
            type: "image",
            source: "blob",
            blob_id: block.blob_id,
            media_type: block.media_type as MeerkatImageRef["media_type"],
          },
        },
      ];
    if (block.type === "structured")
      return [{ kind: "details", label: "Structured result", value: block.data }];
    if (block.type === "skill_context")
      return [{ kind: "details", label: "Skill context", value: block.text }];
    return [
      {
        kind: "details",
        label: block.type === "image" ? "Image reference" : "Saved content",
        value: block,
      },
    ];
  });
}

/** Display native committed messages without synthesizing console events or role provenance. */
export function savedMessageView(message: unknown, agentLabel: string): SavedMessageView | null {
  const native = record(message);
  if (!native || native.role === "system") return null;
  const timestamp =
    typeof native.created_at === "string" && Number.isFinite(Date.parse(native.created_at))
      ? native.created_at
      : undefined;
  const base = { user: false, ...(timestamp ? { timestamp } : {}) };
  if (native.role === "system_notice") {
    const peers = nativePeerNotices(native);
    if (peers.length)
      return {
        ...base,
        label: "Peer communication",
        parts: [
          ...peers.map((peer): SavedMessagePart => ({
            kind: "peer",
            label: peer.label,
            value: peer.value,
            peer,
          })),
          { kind: "details", label: "Message details", value: native },
        ],
      };
  }
  if (native.role === "user") {
    const user =
      native.transcript_role === undefined || native.transcript_role === "conversational";
    return {
      ...base,
      user,
      label: user
        ? "Input"
        : native.transcript_role === "compaction_summary"
          ? "Conversation summary"
          : "Attached context",
      parts: contentParts(native.content),
    };
  }
  if (native.role === "block_assistant") {
    const parts = (Array.isArray(native.blocks) ? native.blocks : []).flatMap(
      (value): SavedMessagePart[] => {
        const block = record(value);
        const data = record(block?.data);
        if (!block || !data) return [];
        if (
          (block.block_type === "text" || block.block_type === "transcript") &&
          typeof data.text === "string"
        )
          return [{ kind: "text", text: data.text }];
        if (block.block_type === "reasoning" && typeof data.text === "string")
          return [{ kind: "reasoning", text: data.text }];
        if (block.block_type === "tool_use")
          return [
            {
              kind: "tool",
              label: typeof data.name === "string" ? data.name : "Tool call",
              value: data.args,
              error: false,
            },
          ];
        if (block.block_type === "image") {
          const blob = record(data.blob_ref);
          const image = blob
            ? contentParts([
                {
                  type: "image",
                  source: "blob",
                  blob_id: blob.blob_id,
                  media_type: blob.media_type,
                },
              ]).find((part) => part.kind === "image")
            : undefined;
          if (image) return [image];
        }
        return [{ kind: "details", label: "Assistant activity", value: block }];
      },
    );
    return { ...base, label: agentLabel, parts };
  }
  if (native.role === "tool_results") {
    const parts = (Array.isArray(native.results) ? native.results : []).flatMap(
      (value): SavedMessagePart[] => {
        const result = record(value);
        if (!result) return [];
        return [
          {
            kind: "tool",
            label: result.is_error === true ? "Tool error" : "Tool result",
            value: result.content,
            error: result.is_error === true,
          },
          ...contentParts(result.content).filter((part) => part.kind === "image"),
        ];
      },
    );
    return { ...base, label: "Tools", parts };
  }
  return {
    ...base,
    label: native.role === "system_notice" ? "System notice" : "Saved message",
    parts: [{ kind: "details", label: "Message details", value: native }],
  };
}

/** Offsets are meaningful only within the same native committed revision. */
export function mergeSavedTranscriptPages(
  current: MeerkatSavedTranscript,
  older: MeerkatSavedTranscript,
): MeerkatSavedTranscript {
  if (current.sessionId !== older.sessionId || current.storeRevision !== older.storeRevision)
    throw new Error("The saved conversation changed. Refresh it before loading older messages.");
  const messages = new Map(
    [...older.messages, ...current.messages].map((entry) => [entry.offset, entry]),
  );
  const progressed =
    older.nextBefore !== undefined &&
    current.nextBefore !== undefined &&
    older.nextBefore < current.nextBefore;
  if (!older.exhausted && !progressed)
    throw new Error("The saved conversation cursor stopped advancing. Refresh it to continue.");
  return {
    ...older,
    messages: [...messages.values()].sort((left, right) => left.offset - right.offset),
  };
}

export function savedTranscriptText(
  transcript: MeerkatSavedTranscript,
  agentLabel: string,
): string {
  return transcript.messages
    .flatMap(({ message }) => {
      const view = savedMessageView(message, agentLabel);
      if (!view) return [];
      const text = view.parts
        .map((part) =>
          part.kind === "text" || part.kind === "reasoning"
            ? part.text
            : part.kind === "peer"
              ? `${part.label}: ${part.peer.text ?? ""}`
              : part.kind === "image"
                ? "[Image]"
                : `${part.label}: ${typeof part.value === "string" ? part.value : JSON.stringify(part.value)}`,
        )
        .join("\n\n");
      return [`${view.label}: ${text}`];
    })
    .join("\n\n");
}
