// @effect-diagnostics nodeBuiltinImport:off - native transport uses base64 only on bounded upload requests.
import * as NodeBuffer from "node:buffer";
import {
  MEERKAT_MAX_IMAGE_BYTES,
  MEERKAT_MAX_IMAGES,
  MeerkatImageUpload,
  type ChatAttachment,
  MeerkatImageRef,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import type { MeerkatGatewayClient } from "./MeerkatGatewayClient.ts";

const decodeUpload = Schema.decodeUnknownSync(MeerkatImageUpload);
const decodeImageRef = Schema.decodeUnknownOption(MeerkatImageRef);

export type MeerkatContent =
  | string
  | ReadonlyArray<{ type: "text"; text: string } | MeerkatImageRef>;
export async function prepareMeerkatContent(input: {
  text?: string | undefined;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  attachmentsDir?: string | undefined;
  scope: Readonly<Record<string, unknown>>;
  client: Pick<MeerkatGatewayClient, "request">;
  readFile: (path: string) => Promise<Uint8Array>;
}): Promise<MeerkatContent> {
  const attachments = input.attachments ?? [];
  if (!attachments.length) return input.text ?? "";
  if (attachments.length > MEERKAT_MAX_IMAGES)
    throw new Error("Meerkat supports up to 8 images per message.");
  if (!input.attachmentsDir) throw new Error("Image attachment storage is unavailable.");
  const images: MeerkatImageRef[] = [];
  for (const attachment of attachments) {
    if (
      attachment.type !== "image" ||
      !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(attachment.mimeType)
    )
      throw new Error("Meerkat supports PNG, JPEG, GIF and WebP attachments.");
    if (attachment.sizeBytes > MEERKAT_MAX_IMAGE_BYTES)
      throw new Error("Images must be 10 MiB or smaller.");
    const path = resolveAttachmentPath({ attachmentsDir: input.attachmentsDir, attachment });
    if (!path) throw new Error("Image attachment path is invalid.");
    const bytes = await input.readFile(path);
    if (bytes.byteLength !== attachment.sizeBytes || bytes.byteLength > MEERKAT_MAX_IMAGE_BYTES)
      throw new Error("Stored image size does not match the uploaded attachment.");
    const result = decodeUpload(
      await input.client.request("mobs.v1.imageUpload", {
        ...input.scope,
        mediaType: attachment.mimeType,
        dataBase64: NodeBuffer.Buffer.from(bytes).toString("base64"),
      }),
    );
    images.push({
      type: "image",
      media_type: result.blob.mediaType,
      source: "blob",
      blob_id: result.blob.blobId,
    });
  }
  return [...(input.text?.trim() ? [{ type: "text" as const, text: input.text }] : []), ...images];
}

/** Collect references only; inline tool payloads are never promoted into timeline JSON. */
export function nativeImageRefs(value: unknown): MeerkatImageRef[] {
  const refs = new Map<string, MeerkatImageRef>();
  function visit(entry: unknown, depth: number) {
    if (depth > 20 || entry === null || typeof entry !== "object") return;
    if (Array.isArray(entry)) {
      for (const child of entry) visit(child, depth + 1);
      return;
    }
    const item = entry as Record<string, unknown>;
    if (
      item.type === "image" &&
      item.source === "blob" &&
      typeof item.blob_id === "string" &&
      typeof item.media_type === "string"
    ) {
      const ref = decodeImageRef(item);
      if (ref._tag === "Some") refs.set(ref.value.blob_id, ref.value);
    }
    for (const [key, child] of Object.entries(item))
      if (key !== "data" && key !== "dataBase64") visit(child, depth + 1);
  }
  visit(value, 0);
  return [...refs.values()];
}
