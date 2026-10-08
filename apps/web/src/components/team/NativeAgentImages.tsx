import {
  meerkatTeamEnvironment as teamAtoms,
  useVisibleTeamRefresh,
} from "../../state/meerkatTeam";
import { createMeerkatMediaAtoms } from "@t3tools/client-runtime/state/meerkatMedia";
import {
  MEERKAT_MAX_IMAGE_BYTES,
  MEERKAT_MAX_IMAGES,
  type EnvironmentId,
  type MeerkatImageRef,
  type MeerkatMediaTarget,
  type MeerkatImageUploadInput,
} from "@t3tools/contracts";
import { useRef, useState } from "react";
import { useStore } from "zustand";
import { DownloadIcon, PaperclipIcon } from "lucide-react";
import { connectionAtomRuntime } from "../../connection/runtime";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { ExpandedImageDialog } from "../chat/ExpandedImageDialog";
import { browserAgentDraftStorage } from "./agentDraftStorage";
import { createNativeImageDraftStore, nativeImageDraftStorageKey } from "./nativeImageDraftStore";
import { isCanonicalAgentDraftKey } from "./agentDraftIdentity";

const media = createMeerkatMediaAtoms(connectionAtomRuntime);
export type NativeMediaScope = MeerkatMediaTarget & { environmentId: EnvironmentId };

function NativeImage({ scope, image }: { scope: NativeMediaScope; image: MeerkatImageRef }) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const { environmentId, ...target } = scope;
  const query = useEnvironmentQuery(
    media.imageRead({ environmentId, input: { ...target, blobId: image.blob_id } }),
  );
  useVisibleTeamRefresh(query, !query.data);
  if (query.error) return <div className="text-xs text-destructive">{query.error}</div>;
  if (!query.data)
    return (
      <div className="h-24 w-32 animate-pulse rounded-md bg-muted" aria-label="Loading image" />
    );
  const src = `data:${query.data.blob.mediaType};base64,${query.data.dataBase64}`;
  const extension = image.media_type === "image/jpeg" ? "jpg" : image.media_type.slice(6);
  const name = `image-${image.blob_id.slice(7, 19)}.${extension}`;
  return (
    <div className="min-w-0 space-y-1">
      <button
        type="button"
        aria-label="Preview conversation image"
        className="block max-w-full cursor-zoom-in rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        onClick={() => setPreviewOpen(true)}
      >
        <img
          className="max-h-80 max-w-full rounded-lg border border-border object-contain"
          src={src}
          alt="Agent conversation image"
          loading="lazy"
        />
      </button>
      <Button size="xs" variant="ghost-muted" render={<a href={src} download={name} />}>
        <DownloadIcon /> Download image
      </Button>
      {previewOpen ? (
        <ExpandedImageDialog
          preview={{ images: [{ src, name }], index: 0 }}
          onClose={() => setPreviewOpen(false)}
        />
      ) : null}
    </div>
  );
}

export function NativeAgentImages({
  scope,
  images,
}: {
  scope: NativeMediaScope;
  images: ReadonlyArray<MeerkatImageRef>;
}) {
  if (!images.length) return null;
  return (
    <div className="flex flex-wrap gap-3 py-2">
      {images.map((image) => (
        <NativeImage
          key={JSON.stringify([
            scope.environmentId,
            scope.projectId,
            scope.instanceId,
            scope.agentRef,
            scope.threadId,
            image.blob_id,
          ])}
          scope={scope}
          image={image}
        />
      ))}
    </div>
  );
}

export function imageRefsFromNative(value: unknown): MeerkatImageRef[] {
  const found = new Map<string, MeerkatImageRef>();
  function visit(entry: unknown, depth: number) {
    if (!entry || typeof entry !== "object" || depth > 20) return;
    if (Array.isArray(entry)) {
      entry.forEach((item) => visit(item, depth + 1));
      return;
    }
    const item = entry as Record<string, unknown>;
    if (
      typeof item.blob_id === "string" &&
      /^sha256:[a-f0-9]{64}$/.test(item.blob_id) &&
      typeof item.media_type === "string" &&
      ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(item.media_type)
    )
      found.set(item.blob_id, {
        type: "image",
        source: "blob",
        blob_id: item.blob_id,
        media_type: item.media_type as MeerkatImageRef["media_type"],
      });
    for (const [key, child] of Object.entries(item))
      if (key !== "data" && key !== "dataBase64") visit(child, depth + 1);
  }
  visit(value, 0);
  return [...found.values()];
}

export function useMeerkatImageAttachments(scope: NativeMediaScope, draftKey?: string) {
  const upload = useAtomCommand(media.imageUpload, { reportFailure: false });
  const storageKey = nativeImageDraftStorageKey(scope, draftKey);
  const createDraft = () => ({
    key: storageKey,
    store: createNativeImageDraftStore(
      storageKey,
      `meerkat-image-draft:${JSON.stringify(scope)}`,
      () => browserAgentDraftStorage("localStorage"),
      draftKey && isCanonicalAgentDraftKey(draftKey)
        ? undefined
        : () => browserAgentDraftStorage("sessionStorage"),
    ),
  });
  const [draft, setDraft] = useState(createDraft);
  let store = draft.store;
  if (draft.key !== storageKey) {
    const next = createDraft();
    store = next.store;
    setDraft(next);
  }
  const { images, uploading, uploadError, persistenceError, readFailed } = useStore(store);
  async function addFiles(files: ReadonlyArray<File>) {
    if (store.getState().uploading) return;
    if (store.getState().readForSend() === null) return;
    // The captured store and media scope keep late uploads with the original target.
    store.setState({ uploading: true, uploadError: null });
    try {
      if (store.getState().images.length + files.length > MEERKAT_MAX_IMAGES)
        throw new Error("Attach up to 8 images per message.");
      const added: MeerkatImageRef[] = [];
      for (const file of files) {
        if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.type))
          throw new Error("Choose a PNG, JPEG, GIF or WebP image.");
        if (file.size > MEERKAT_MAX_IMAGE_BYTES)
          throw new Error("Images must be 10 MiB or smaller.");
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.addEventListener("error", () => reject(new Error("Image could not be read.")), {
            once: true,
          });
          reader.addEventListener(
            "load",
            () => resolve(String(reader.result).split(",")[1] ?? ""),
            { once: true },
          );
          reader.readAsDataURL(file);
        });
        const { environmentId, ...target } = scope;
        const result = await upload({
          environmentId,
          input: {
            ...target,
            mediaType: file.type as MeerkatImageUploadInput["mediaType"],
            dataBase64: data,
          },
        });
        if (result._tag === "Failure") throw new Error(formatEnvironmentQueryError(result.cause));
        added.push({
          type: "image",
          media_type: result.value.blob.mediaType,
          source: "blob",
          blob_id: result.value.blob.blobId,
        });
      }
      store.getState().updateImages((current) => imageRefsFromNative([...current, ...added]), true);
    } catch (cause) {
      store.setState({ uploadError: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      store.setState({ uploading: false });
    }
  }
  return {
    images,
    uploading,
    readFailed,
    error: readFailed ? persistenceError : (uploadError ?? persistenceError),
    retryRead: () => store.getState().retryRead(),
    readForSend: () => store.getState().readForSend(),
    addFiles,
    remove: (blobId: string) =>
      store
        .getState()
        .updateImages((current) => current.filter((image) => image.blob_id !== blobId)),
    clearAcknowledged: (sent: ReadonlyArray<MeerkatImageRef>) => {
      const acknowledged = new Set(sent.map((image) => image.blob_id));
      return store
        .getState()
        .updateImages((current) => current.filter((image) => !acknowledged.has(image.blob_id)));
    },
    clear: () => store.getState().updateImages(() => []),
  };
}

export function NativeImageDraftRecovery({
  attachments,
}: {
  attachments: ReturnType<typeof useMeerkatImageAttachments>;
}) {
  if (!attachments.error) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 px-3 text-xs">
      <p role="status" className="text-destructive">
        {attachments.error}
      </p>
      {attachments.readFailed ? (
        <Button type="button" size="xs" variant="outline" onClick={attachments.retryRead}>
          Retry loading images
        </Button>
      ) : null}
    </div>
  );
}

export function NativeImageAttachmentButton({
  attachments,
  disabled,
}: {
  attachments: ReturnType<typeof useMeerkatImageAttachments>;
  disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        className="hidden"
        onChange={(event) => {
          void attachments.addFiles(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />
      <Button
        size="icon-sm"
        variant="ghost-muted"
        aria-label={attachments.uploading ? "Uploading image" : "Attach images"}
        title={attachments.uploading ? "Uploading image..." : "Attach images"}
        disabled={disabled || attachments.uploading || attachments.readFailed}
        onClick={() => input.current?.click()}
      >
        <PaperclipIcon />
      </Button>
    </>
  );
}

/** Native image outputs remain available even after T3 reconnects its text projection. */
export function ThreadNativeImages({
  environmentId,
  projectId,
  instanceId,
  threadId,
}: NativeMediaScope & { threadId: NonNullable<MeerkatMediaTarget["threadId"]> }) {
  const team = useEnvironmentQuery(teamAtoms.projectTeam({ environmentId, input: { projectId } }));
  useVisibleTeamRefresh(team, true);
  const agent = team.data?.providers
    .find((provider) => provider.instanceId === instanceId)
    ?.agents.find(
      (candidate) =>
        candidate.threadId === threadId &&
        candidate.record.runtime_member_id === "ingress" &&
        !candidate.record.labels.source_mob_id,
    );
  const history = useEnvironmentQuery(
    agent
      ? teamAtoms.agentActivity({
          environmentId,
          input: { projectId, instanceId, agentRef: agent.agentRef, limit: 100 },
        })
      : null,
  );
  useVisibleTeamRefresh(history, Boolean(agent));
  const images = imageRefsFromNative(
    history.data?.timeline.frames.filter(
      (frame) =>
        frame.kind === "assistant_image" ||
        frame.kind.startsWith("tool") ||
        frame.kind === "assistant_message",
    ),
  );
  return images.length ? (
    <div className="px-6">
      <NativeAgentImages
        scope={{ environmentId, projectId, instanceId, threadId }}
        images={images}
      />
    </div>
  ) : null;
}
