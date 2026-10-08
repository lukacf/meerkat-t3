import {
  MEERKAT_MAX_IMAGE_BYTES,
  MEERKAT_MAX_IMAGES,
  TextGenerationError,
  type ChatAttachment,
  type ModelSelection,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import type * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "../../textGeneration/TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
  toJsonSchemaObject,
} from "../../textGeneration/TextGenerationUtils.ts";
import { decodeMeerkatModel, meerkatProjectStateRoot } from "../Layers/MeerkatAdapter.ts";
import type { MeerkatGatewayClient } from "./MeerkatGatewayClient.ts";
import { resolveMeerkatProviderParams } from "./MeerkatModelOptions.ts";
import type { MeerkatWorkspacePreparer } from "./MeerkatWorkspacePolicy.ts";

interface Options {
  readonly client: MeerkatGatewayClient;
  readonly instanceId: ProviderInstanceId;
  readonly stateRoot: string;
  readonly enabled: boolean;
  readonly attachmentsDir: string;
  readonly prepareWorkspace: MeerkatWorkspacePreparer;
}

type Operation = keyof TextGeneration.TextGeneration["Service"];

/** One native request with explicit credentials/model policy and no agent tools or history. */
export const makeMeerkatTextGeneration = Effect.fn("makeMeerkatTextGeneration")(function* (
  options: Options,
) {
  const path = yield* Path.Path;
  const run = Effect.fn("MeerkatTextGeneration.run")(function* <S extends Schema.Top>(input: {
    operation: Operation;
    cwd: string;
    modelSelection: ModelSelection;
    prompt: string;
    outputSchema: S;
    attachments?: ReadonlyArray<ChatAttachment> | undefined;
  }): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"]> {
    const response = yield* Effect.tryPromise({
      try: async (signal) => {
        if (!options.enabled) throw new Error("The selected Meerkat provider is disabled.");
        if (input.modelSelection.instanceId !== options.instanceId)
          throw new Error("Text generation provider selection does not match this instance.");
        const model = decodeMeerkatModel(input.modelSelection.model);
        const attachments = input.attachments ?? [];
        if (attachments.length > MEERKAT_MAX_IMAGES)
          throw new Error("Meerkat supports up to 8 images per writing request.");
        const images = attachments.map((attachment) => {
          if (
            attachment.type !== "image" ||
            !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(attachment.mimeType) ||
            attachment.sizeBytes > MEERKAT_MAX_IMAGE_BYTES
          )
            throw new Error(
              "Writing requests support PNG, JPEG, GIF and WebP images up to 10 MiB.",
            );
          const imagePath = resolveAttachmentPath({
            attachmentsDir: options.attachmentsDir,
            attachment,
          });
          if (!imagePath) throw new Error("Image attachment path is invalid.");
          return { path: imagePath, mediaType: attachment.mimeType };
        });
        const configStateRoot = meerkatProjectStateRoot(path, options.stateRoot, input.cwd);
        await options.prepareWorkspace(input.cwd, configStateRoot);
        const providerParams = await resolveMeerkatProviderParams({
          client: options.client,
          projectPath: input.cwd,
          configStateRoot,
          ...model,
          options: input.modelSelection.options,
          signal,
        });
        return options.client.request(
          "text.v1.generate",
          {
            projectPath: input.cwd,
            configStateRoot,
            ...model,
            providerParams: providerParams ?? null,
            prompt: input.prompt,
            outputSchema: toJsonSchemaObject(input.outputSchema),
            images,
          },
          { signal, timeoutMs: 95_000 },
        );
      },
      catch: (cause) =>
        new TextGenerationError({
          operation: input.operation,
          detail: cause instanceof Error ? cause.message : "Meerkat text generation failed.",
          cause,
        }),
    });
    return yield* Schema.decodeUnknownEffect(Schema.Struct({ output: Schema.Unknown }))(
      response,
    ).pipe(
      Effect.flatMap((result) => Schema.decodeUnknownEffect(input.outputSchema)(result.output)),
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation: input.operation,
            detail: "Meerkat returned invalid structured output.",
            cause,
          }),
      ),
    );
  });

  return {
    generateCommitMessage: Effect.fn("MeerkatTextGeneration.generateCommitMessage")(
      function* (input) {
        const generated = yield* run({
          ...input,
          ...buildCommitMessagePrompt(input),
          operation: "generateCommitMessage",
        });
        return {
          subject: sanitizeCommitSubject(generated.subject),
          body: generated.body.trim(),
          ...("branch" in generated && typeof generated.branch === "string"
            ? { branch: sanitizeFeatureBranchName(generated.branch) }
            : {}),
        };
      },
    ),
    generatePrContent: Effect.fn("MeerkatTextGeneration.generatePrContent")(function* (input) {
      const generated = yield* run({
        ...input,
        ...buildPrContentPrompt(input),
        operation: "generatePrContent",
      });
      return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
    }),
    generateBranchName: Effect.fn("MeerkatTextGeneration.generateBranchName")(function* (input) {
      const generated = yield* run({
        ...input,
        ...buildBranchNamePrompt(input),
        operation: "generateBranchName",
      });
      return { branch: sanitizeBranchFragment(generated.branch) };
    }),
    generateThreadTitle: Effect.fn("MeerkatTextGeneration.generateThreadTitle")(function* (input) {
      const generated = yield* run({
        ...input,
        ...buildThreadTitlePrompt(input),
        operation: "generateThreadTitle",
      });
      return {
        title: sanitizeThreadTitle(generated.title),
        ...(generated.needsRefinement ? { needsRefinement: true } : {}),
      };
    }),
  } satisfies TextGeneration.TextGeneration["Service"];
});
