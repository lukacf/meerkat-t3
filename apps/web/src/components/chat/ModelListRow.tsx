import { type ProviderDriverKind, type ProviderInstanceId } from "@t3tools/contracts";
import { memo, useId } from "react";
import { CheckIcon, StarIcon } from "lucide-react";
import {
  getDisplayModelName,
  getTriggerDisplayModelLabel,
  type ModelEsque,
  PROVIDER_ICON_BY_PROVIDER,
} from "./providerIconUtils";
import { ComboboxItem } from "../ui/combobox";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Kbd } from "../ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { modelPickerModelKey } from "./modelPickerKeys";
import { modelCredentialRequirement } from "../../modelCredentials";

export const ModelListRow = memo(function ModelListRow(props: {
  index: number;
  model: ModelEsque;
  /** Instance the model belongs to — the routing key used in combobox values. */
  instanceId: ProviderInstanceId;
  /** Driver kind of the instance — used for the provider icon glyph. */
  driverKind: ProviderDriverKind;
  /**
   * Display name to show in the secondary line (provider footer). Usually
   * the instance's configured `displayName` so custom instances like
   * "Codex Personal" render with their user-authored label.
   */
  providerDisplayName: string;
  providerAccentColor?: string | undefined;
  isFavorite: boolean;
  isSelected: boolean;
  showSelection?: boolean;
  showProvider: boolean;
  sectionLabel?: string | undefined;
  showModelId?: boolean;
  showCatalogTier?: boolean;
  preferShortName?: boolean;
  useTriggerLabel?: boolean;
  showNewBadge?: boolean;
  unavailable?: boolean;
  jumpLabel?: string | null;
  disabledReason?: string | null;
  onToggleFavorite: () => void;
}) {
  const sectionLabelId = useId();
  const ProviderIcon = PROVIDER_ICON_BY_PROVIDER[props.driverKind] ?? null;
  const providerLabel =
    props.driverKind === "meerkat"
      ? (props.model.accountLabel ?? "")
      : props.model.subProvider
        ? `${props.providerDisplayName} · ${props.model.subProvider}`
        : props.providerDisplayName;
  const catalogLabel =
    props.showCatalogTier && props.driverKind === "meerkat"
      ? props.model.catalogTier === "recommended"
        ? "Recommended"
        : props.model.catalogTier === "supported"
          ? "Supported"
          : props.model.catalogTier === "custom"
            ? "Configured"
            : null
      : null;

  const row = (
    <ComboboxItem
      hideIndicator
      index={props.index}
      value={modelPickerModelKey(props.instanceId, props.model.slug)}
      aria-describedby={props.sectionLabel ? sectionLabelId : undefined}
      disabled={Boolean(props.disabledReason)}
      className={cn(
        "group relative w-full !min-w-0 max-w-full cursor-pointer",
        props.disabledReason &&
          "data-disabled:pointer-events-auto data-disabled:cursor-not-allowed",
      )}
    >
      <div className="min-w-0 flex-1 text-left">
        <div className="flex min-w-0 items-center gap-2">
          <div className="min-w-0 truncate text-xs font-medium leading-snug">
            {props.useTriggerLabel
              ? getTriggerDisplayModelLabel(props.model)
              : getDisplayModelName(
                  props.model,
                  props.preferShortName ? { preferShortName: true } : undefined,
                )}
          </div>
          {props.showNewBadge ? (
            <span
              className="shrink-0 rounded border border-update/35 bg-update/15 px-0.5 py-px text-3xs font-bold uppercase leading-none tracking-wide text-update-foreground"
              aria-label="New model"
            >
              New
            </span>
          ) : null}
          {modelCredentialRequirement(props.model, props.driverKind === "meerkat") ? (
            <Badge variant="outline" size="sm">
              Connect account
            </Badge>
          ) : props.unavailable ? (
            <Badge variant="outline" size="sm">
              Unavailable
            </Badge>
          ) : null}
        </div>
        {props.showProvider && (providerLabel || props.showModelId || catalogLabel) && (
          <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
            {ProviderIcon ? <ProviderIcon className="size-3 shrink-0" /> : null}
            {(providerLabel || catalogLabel) && (
              <span className="truncate text-xs font-normal leading-snug text-muted-foreground/70">
                {[providerLabel, catalogLabel].filter(Boolean).join(" · ")}
              </span>
            )}
            {props.showModelId && (
              <span className="w-full break-all font-mono text-3xs leading-snug text-muted-foreground/70">
                {props.driverKind === "meerkat"
                  ? props.model.slug.slice(props.model.slug.indexOf(":") + 1)
                  : props.model.slug}
              </span>
            )}
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {props.showSelection && props.isSelected ? (
          <CheckIcon className="size-3.5" aria-hidden="true" />
        ) : null}
        {props.jumpLabel ? <Kbd>{props.jumpLabel}</Kbd> : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost-muted"
                className="-mr-1 shrink-0"
                onClick={(event) => {
                  event.stopPropagation();
                  props.onToggleFavorite();
                }}
                onKeyDown={(event) => {
                  event.stopPropagation();
                }}
                disabled={Boolean(props.disabledReason)}
                aria-label={props.isFavorite ? "Remove from favorites" : "Add to favorites"}
              >
                <StarIcon
                  className={cn(
                    "size-3.5 sm:size-3",
                    props.isFavorite && "fill-current text-warning",
                  )}
                />
              </Button>
            }
          />
          <TooltipPopup side="top" align="center">
            {props.isFavorite ? "Remove from favorites" : "Add to favorites"}
          </TooltipPopup>
        </Tooltip>
      </div>
    </ComboboxItem>
  );

  return (
    <>
      {props.sectionLabel ? (
        <div
          id={sectionLabelId}
          role="presentation"
          className="px-2 pb-1 pt-2 text-3xs font-medium leading-5 text-muted-foreground"
        >
          {props.sectionLabel}
        </div>
      ) : null}
      {props.disabledReason ? (
        <Tooltip>
          <TooltipTrigger render={row} />
          <TooltipPopup side="left" align="center">
            {props.disabledReason}
          </TooltipPopup>
        </Tooltip>
      ) : (
        row
      )}
    </>
  );
});
