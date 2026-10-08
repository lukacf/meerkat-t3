export type NativePeerMessage = {
  label: string;
  text: string | null;
  content: unknown;
  value: unknown;
  status?: string;
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Extract display prose only inside an already identified native comms record.
 * Unknown structured fields remain available in the original record's details.
 */
function peerText(value: unknown, depth = 0): string | null {
  if (depth > 8) return null;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return null;
    if (/^[\[{\"]/.test(text)) {
      try {
        return peerText(JSON.parse(text), depth + 1);
      } catch {
        // Ordinary prose may begin with a quote or a Markdown link.
      }
    }
    return text;
  }
  if (value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    const parts = value.flatMap((part) => {
      const text = peerText(part, depth + 1);
      return text ? [text] : [];
    });
    return parts.length ? parts.join("\n\n") : null;
  }
  const payload = record(value);
  if (typeof payload.type === "string" && payload.type !== "text") return null;
  for (const key of [
    "text",
    "message",
    "body",
    "summary",
    "reply",
    "token",
    "content",
    "subject",
    "question",
    "prompt",
    "description",
    "result",
    "params",
  ]) {
    const text = peerText(payload[key], depth + 1);
    if (text) return text;
  }
  return null;
}

/** The native system-notice envelope is the provenance boundary, not body text. */
export function nativePeerNotices(message: unknown): NativePeerMessage[] {
  const notice = record(message);
  if (notice.role !== "system_notice" || !Array.isArray(notice.blocks)) return [];
  return notice.blocks.flatMap((value): NativePeerMessage[] => {
    const block = record(value);
    if (block.type !== "comms") return [];
    const base =
      block.kind === "request"
        ? "Peer request"
        : block.kind === "response_terminal"
          ? "Peer response"
          : block.kind === "response_progress"
            ? "Peer progress update"
            : block.kind === "message"
              ? "Peer message"
              : "Peer activity";
    const peer = record(block.peer);
    const name = typeof peer.display_name === "string" ? peer.display_name.trim() : "";
    const direction =
      block.direction === "incoming" ? "from" : block.direction === "outgoing" ? "to" : null;
    // Intent, transport summary and opaque routing identity are diagnostics,
    // not the title or message. The native peer display name is authoritative.
    return [
      {
        label: name && direction ? `${base} ${direction} ${name}` : base,
        text: peerText(block.payload) ?? peerText(block.content),
        content: block.content,
        value,
        ...(typeof block.status === "string" ? { status: block.status } : {}),
      },
    ];
  });
}

export function nativePeerTool(name: unknown, args: unknown): NativePeerMessage | null {
  const label =
    name === "send_request"
      ? "Request to peer"
      : name === "send_response"
        ? "Response to peer"
        : name === "send_message"
          ? "Message to peer"
          : null;
  if (!label) return null;
  const input = record(args);
  return {
    label,
    text: peerText(input.body) ?? peerText(input.params) ?? peerText(input.result),
    content: args,
    value: args,
  };
}
