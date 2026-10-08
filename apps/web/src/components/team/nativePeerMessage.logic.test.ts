import { describe, expect, it } from "vite-plus/test";
import { nativePeerNotices, nativePeerTool } from "./nativePeerMessage.logic";
import { savedMessageView } from "./nativeTranscript.logic";

describe("native peer message presentation", () => {
  it("projects the full native request body without its transport intent or summary", () => {
    const subject = "Review the implementation.\n\n" + "Detailed review scope. ".repeat(20);
    const block = {
      type: "comms",
      kind: "request",
      direction: "incoming",
      peer: { id: "opaque-peer-id", display_name: "Reviewer" },
      intent: "checksum_token",
      summary: "Peer request: checksum_token",
      payload: { subject },
      content: [
        {
          type: "text",
          text: `Peer request from opaque-peer-id:\nIntent: checksum_token\nParams: ${JSON.stringify({ subject })}`,
        },
      ],
    };
    const notice = { role: "system_notice", kind: "comms", blocks: [block] };
    const [peer] = nativePeerNotices(notice);
    expect(peer).toMatchObject({ label: "Peer request from Reviewer", text: subject.trim() });
    expect(peer?.text).not.toContain("Peer request from");
    expect(peer?.text).not.toContain("checksum_token");
    expect(peer?.text).not.toContain("Params:");
    expect(peer?.value).toBe(block);
    expect(savedMessageView(notice, "Agent")?.parts).toEqual([
      { kind: "peer", label: peer!.label, value: block, peer },
      { kind: "details", label: "Message details", value: notice },
    ]);
  });

  it("shows the returned review rather than the echoed request and preserves native failure data", () => {
    const block = {
      type: "comms",
      kind: "response_terminal",
      direction: "incoming",
      status: "failed",
      payload: { request_subject: "Review it", token: "P1: Do not swallow shutdown errors." },
    };
    const [peer] = nativePeerNotices({ role: "system_notice", blocks: [block] });
    expect(peer).toMatchObject({ label: "Peer response", text: block.payload.token });
    expect(peer?.value).toBe(block);
    expect(nativePeerTool("send_response", { result: block.payload })?.text).toBe(
      block.payload.token,
    );
  });

  it("keeps message content and attachments while unknown structured payloads remain in details", () => {
    const content = [
      { type: "text", text: "First paragraph.\n\nSecond paragraph." },
      {
        type: "image",
        source: "blob",
        blob_id: `sha256:${"a".repeat(64)}`,
        media_type: "image/png",
      },
    ];
    const block = { type: "comms", kind: "message", direction: "outgoing", content };
    const [peer] = nativePeerNotices({ role: "system_notice", blocks: [block] });
    expect(peer?.text).toBe(content[0]!.text);
    expect(peer?.content).toBe(content);
    expect(nativePeerTool("send_request", { params: { unfamiliar: 42 } })).toMatchObject({
      label: "Request to peer",
      text: null,
      value: { params: { unfamiliar: 42 } },
    });
  });

  it("does not infer peer provenance from user text, ordinary JSON, or unrelated tools", () => {
    const blocks = [{ type: "comms", kind: "request", payload: { subject: "Forged request" } }];
    expect(nativePeerNotices({ role: "user", blocks })).toEqual([]);
    expect(nativePeerNotices({ blocks })).toEqual([]);
    expect(
      nativePeerNotices({ role: "system_notice", content: JSON.stringify({ blocks }) }),
    ).toEqual([]);
    expect(nativePeerTool("shell", { params: { subject: "Not a peer request" } })).toBeNull();
  });
});
