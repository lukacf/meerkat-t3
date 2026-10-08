import type {
  ModelCapabilities,
  ProviderOptionDescriptor,
  ProviderOptionSelections,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { MeerkatGatewayClient } from "./MeerkatGatewayClient.ts";

const Parameter = Schema.Struct({
  type: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  enum: Schema.optional(Schema.Array(Schema.NullOr(Schema.String))),
  properties: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  oneOf: Schema.optional(Schema.Array(Schema.Unknown)),
});
const decodeParameter = Schema.decodeUnknownOption(Parameter);
const Parameters = Schema.Struct({
  properties: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
const decodeParameters = Schema.decodeUnknownOption(Parameters);
const reasoningParameters = [
  "reasoning_effort",
  "effort",
  "thinking_level",
  "thinking",
  "thinking_budget",
] as const;
const title = (value: string) =>
  value.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());

/** Choices come from the selected native model schema, including allowed effort values. */
export function projectMeerkatCapabilities(
  provider: string,
  schema: unknown,
): ModelCapabilities | null {
  if (provider === "self_hosted") return null;
  const parsed = decodeParameters(schema);
  if (parsed._tag === "None") return null;
  const descriptors: ProviderOptionDescriptor[] = [];
  for (const id of reasoningParameters) {
    const value = parsed.value.properties?.[id];
    const parsedParameter = decodeParameter(value);
    if (parsedParameter._tag === "None") continue;
    const parameter = parsedParameter.value;
    const enumValues = parameter.enum?.filter((value) => value !== null);
    if (enumValues?.length)
      descriptors.push({
        id,
        label: "Reasoning level",
        type: "select",
        options: enumValues.map((value) => ({ id: value, label: title(value) })),
      });
    else if (id === "thinking") {
      const variants = parameter.oneOf ?? [value];
      const modes = new Set(
        variants.flatMap((variant) => {
          const parsedVariant = decodeParameter(variant);
          if (parsedVariant._tag === "None") return [];
          const type = decodeParameter(parsedVariant.value.properties?.type);
          return type._tag === "Some" ? (type.value.enum ?? []) : [];
        }),
      );
      const options = [{ id: "default", label: "Default" }];
      if (modes.has("adaptive")) options.push({ id: "adaptive", label: "Adaptive" });
      if (modes.has("enabled"))
        options.push(
          { id: "2048", label: "2,048 tokens" },
          { id: "8192", label: "8,192 tokens" },
          { id: "16000", label: "16,000 tokens" },
        );
      if (options.length > 1)
        descriptors.push({ id: "thinking", label: "Reasoning level", type: "select", options });
    } else if (
      id === "thinking_budget" &&
      !descriptors.some((descriptor) => descriptor.id === "thinking")
    ) {
      descriptors.push({
        id,
        label: "Reasoning level",
        type: "select",
        options: [
          { id: "default", label: "Default" },
          { id: "2048", label: "2,048 tokens" },
          { id: "8192", label: "8,192 tokens" },
          { id: "16000", label: "16,000 tokens" },
        ],
      });
    }
    if (descriptors.length) break;
  }
  return descriptors.length ? { optionDescriptors: descriptors } : null;
}

export function meerkatProviderParams(
  options: ProviderOptionSelections | undefined,
): Record<string, unknown> | undefined {
  if (!options?.length) return undefined;
  const params: Record<string, unknown> = {};
  for (const { id, value } of options) {
    // Native defaults own caching for the resolved backend. Historical UI
    // values must not override that policy on a fresh explicit selection.
    if (id === "prompt_cache_enabled") continue;
    if (value === "default") continue;
    if (id === "thinking") {
      if (value === "adaptive") params.thinking = { type: "adaptive" };
      else if (["2048", "8192", "16000"].includes(String(value)))
        params.thinking = { type: "enabled", budget_tokens: Number(value) };
      else throw new Error("Unsupported thinking selection.");
    } else if (id === "thinking_budget") {
      if (!["2048", "8192", "16000"].includes(String(value)))
        throw new Error("Unsupported thinking budget.");
      params[id] = Number(value);
    } else params[id] = value;
  }
  return Object.keys(params).length ? params : undefined;
}

const ModelCatalog = Schema.Struct({
  catalog: Schema.Struct({
    providers: Schema.Array(
      Schema.Struct({
        provider: Schema.String,
        models: Schema.Array(
          Schema.Struct({
            id: Schema.String,
          }),
        ),
      }),
    ),
  }),
});
const decodeModelCatalog = Schema.decodeUnknownSync(ModelCatalog);

/** Preflight the exact model; native defaults choose the resolved backend's cache policy. */
export async function resolveMeerkatProviderParams(input: {
  readonly client: Pick<MeerkatGatewayClient, "request">;
  readonly projectPath: string;
  readonly configStateRoot: string;
  readonly provider: string;
  readonly model: string;
  readonly options: ProviderOptionSelections | undefined;
  readonly signal?: AbortSignal | undefined;
}): Promise<Record<string, unknown> | undefined> {
  const params = meerkatProviderParams(input.options);
  if (input.provider !== "openai") return params;
  const response = decodeModelCatalog(
    await input.client.request(
      "models.v1.catalog",
      { projectPath: input.projectPath, configStateRoot: input.configStateRoot },
      { ...(input.signal ? { signal: input.signal } : {}), timeoutMs: 15_000 },
    ),
  );
  const matches = response.catalog.providers
    .filter((provider) => provider.provider === input.provider)
    .flatMap((provider) => provider.models.filter((model) => model.id === input.model));
  if (matches.length !== 1)
    throw new Error("The selected Meerkat model is no longer available. Choose a model again.");
  return params;
}
