import type { ModelSelection, ProviderTurnHandlingMode } from "@t3tools/contracts";
import { isMeerkatReasoningOption } from "@t3tools/shared/model";

export function resolveMeerkatTurnDispatch(input: {
  readonly provider: string;
  readonly phase: string;
  readonly selectedModel: ModelSelection;
  readonly activeModel?: ModelSelection;
}): {
  readonly handlingMode?: ProviderTurnHandlingMode;
  readonly modelSelection?: ModelSelection;
  readonly blockReason: string | null;
} {
  if (input.provider !== "meerkat") {
    return { modelSelection: input.selectedModel, blockReason: null };
  }
  if (input.phase === "running") {
    const activeOptionIds = new Set(input.activeModel?.options?.map((option) => option.id));
    // Fresh turns omit hidden controls and draft-only Model default intent.
    // Keep comparing every option the active turn actually uses, while not
    // mistaking those retained draft fields for a new steering override.
    const selectedOptions = input.selectedModel.options?.filter(
      (option) =>
        activeOptionIds.has(option.id) ||
        (isMeerkatReasoningOption(option.id) && option.value !== "default"),
    );
    const options = (selection: ModelSelection) =>
      JSON.stringify(
        [...(selection.options ?? [])].sort((left, right) => left.id.localeCompare(right.id)),
      );
    if (
      !input.activeModel ||
      input.activeModel.instanceId !== input.selectedModel.instanceId ||
      input.activeModel.model !== input.selectedModel.model ||
      options(input.activeModel) !==
        options({
          ...input.selectedModel,
          ...(selectedOptions ? { options: selectedOptions } : {}),
        })
    )
      return {
        blockReason:
          "Steering keeps the active model and options. Apply model changes on the next turn.",
      };
    return {
      handlingMode: "steer",
      blockReason: null,
    };
  }
  return { handlingMode: "queue", modelSelection: input.selectedModel, blockReason: null };
}

export function meerkatSteeringFailure(activity: {
  readonly kind: string;
  readonly payload: unknown;
}): { requestId: string; detail: string } | null {
  if (
    activity.kind !== "provider.turn.start.failed" ||
    typeof activity.payload !== "object" ||
    activity.payload === null
  )
    return null;
  const payload = activity.payload as Record<string, unknown>;
  if (typeof payload.requestId !== "string") return null;
  return {
    requestId: payload.requestId,
    detail:
      typeof payload.detail === "string"
        ? payload.detail
        : "Steering was not confirmed. The message is held for review.",
  };
}
