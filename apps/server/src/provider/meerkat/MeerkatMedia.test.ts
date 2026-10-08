import { describe, expect, it } from "@effect/vitest";
import { MEERKAT_MAX_IMAGE_BYTES, type ChatAttachment } from "@t3tools/contracts";
import { prepareMeerkatContent, nativeImageRefs } from "./MeerkatMedia.ts";
import type { MeerkatGatewayClient } from "./MeerkatGatewayClient.ts";
const blobId = `sha256:${"a".repeat(64)}`;
const attachment: ChatAttachment = {
  type: "image",
  id: "thread-00000000-0000-4000-8000-000000000001",
  name: "test.png",
  mimeType: "image/png",
  sizeBytes: 4,
};
const scope = { projectPath: "/project", stateRoot: "/state", mobId: "mob" };
describe("Meerkat native media", () => {
  it("uploads bounded image bytes once and submits durable native refs", async () => {
    const calls: unknown[] = [];
    const client = {
      request: async (method: string, params: unknown) => {
        calls.push({ method, params });
        return { mobId: "mob", blob: { blobId, mediaType: "image/png", size: 4 } };
      },
    } as unknown as MeerkatGatewayClient;
    const result = await prepareMeerkatContent({
      text: "Look",
      attachments: [attachment],
      attachmentsDir: "/attachments",
      scope,
      client,
      readFile: async () => new Uint8Array([1, 2, 3, 4]),
    });
    expect(result).toEqual([
      { type: "text", text: "Look" },
      { type: "image", source: "blob", blob_id: blobId, media_type: "image/png" },
    ]);
    expect(calls).toEqual([
      {
        method: "mobs.v1.imageUpload",
        params: { ...scope, mediaType: "image/png", dataBase64: "AQIDBA==" },
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("AQIDBA");
  });
  it("rejects unsupported, oversized and altered attachments before native upload", async () => {
    let uploads = 0;
    const client = {
      request: async () => {
        uploads++;
      },
    } as unknown as MeerkatGatewayClient;
    const base = {
      attachmentsDir: "/attachments",
      scope,
      client,
      readFile: async () => new Uint8Array([1, 2, 3]),
    };
    for (const changed of [
      { ...attachment, mimeType: "image/svg+xml" },
      { ...attachment, sizeBytes: MEERKAT_MAX_IMAGE_BYTES + 1 },
      attachment,
    ])
      await expect(prepareMeerkatContent({ ...base, attachments: [changed] })).rejects.toThrow();
    expect(uploads).toBe(0);
  });
  it("collects only durable image content refs", () => {
    expect(
      nativeImageRefs([
        { type: "image", media_type: "image/png", source: "inline", data: "AAAA" },
        { type: "image", media_type: "image/png", source: "blob", blob_id: blobId },
      ]),
    ).toEqual([{ type: "image", media_type: "image/png", source: "blob", blob_id: blobId }]);
  });
});
