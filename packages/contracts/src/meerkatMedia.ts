import * as Schema from "effect/Schema";
import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const MEERKAT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MEERKAT_MAX_IMAGES = 8;
export const MeerkatImageMime = Schema.Literals([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);
export const MeerkatBlobId = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/));
export const MeerkatImageRef = Schema.Struct({
  type: Schema.Literal("image"),
  media_type: MeerkatImageMime,
  source: Schema.Literal("blob"),
  blob_id: MeerkatBlobId,
});
export type MeerkatImageRef = typeof MeerkatImageRef.Type;
export const MeerkatMediaTarget = Schema.Struct({
  projectId: ProjectId,
  instanceId: ProviderInstanceId,
  agentRef: Schema.optional(TrimmedNonEmptyString),
  threadId: Schema.optional(ThreadId),
});
export type MeerkatMediaTarget = typeof MeerkatMediaTarget.Type;
export const MeerkatImageUploadInput = Schema.Struct({
  ...MeerkatMediaTarget.fields,
  mediaType: MeerkatImageMime,
  dataBase64: Schema.String.check(Schema.isMaxLength(Math.ceil(MEERKAT_MAX_IMAGE_BYTES / 3) * 4)),
});
export type MeerkatImageUploadInput = typeof MeerkatImageUploadInput.Type;
export const MeerkatImageReadInput = Schema.Struct({
  ...MeerkatMediaTarget.fields,
  blobId: MeerkatBlobId,
});
export const MeerkatImageBlob = Schema.Struct({
  blobId: MeerkatBlobId,
  mediaType: MeerkatImageMime,
  size: Schema.Number,
});
export const MeerkatImageUpload = Schema.Struct({ mobId: Schema.String, blob: MeerkatImageBlob });
export const MeerkatImageRead = Schema.Struct({
  ...MeerkatImageUpload.fields,
  dataBase64: Schema.String,
});
export type MeerkatImageRead = typeof MeerkatImageRead.Type;
export class MeerkatMediaError extends Schema.TaggedError<MeerkatMediaError>()(
  "MeerkatMediaError",
  {
    projectId: ProjectId,
    message: Schema.String,
  },
) {}

export const MeerkatBrowserGrantInput = Schema.Struct({
  ...MeerkatMediaTarget.fields,
  hostThreadId: Schema.optional(ThreadId),
  enabled: Schema.Boolean,
});
export type MeerkatBrowserGrantInput = typeof MeerkatBrowserGrantInput.Type;
export const MeerkatBrowserGrant = Schema.Struct({
  enabled: Schema.Boolean,
  grantRevision: Schema.optional(Schema.Number),
  reason: Schema.optional(
    Schema.Literals(["disabled", "no-host", "no-session", "expired", "revoked", "wrong-workspace"]),
  ),
  message: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.String),
  hostThreadId: Schema.optional(ThreadId),
  hostSessionId: Schema.optional(Schema.String),
  tools: Schema.optional(Schema.Array(Schema.String)),
});
