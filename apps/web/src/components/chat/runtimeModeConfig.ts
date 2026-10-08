import type { RuntimeMode } from "@t3tools/contracts";
import { type LucideIcon, LockIcon, LockOpenIcon, PenLineIcon, SparklesIcon } from "lucide-react";

export const runtimeModeConfig: Record<
  RuntimeMode,
  { label: string; description: string; icon: LucideIcon }
> = {
  "read-only": {
    label: "Read-only",
    description:
      "Read and plan. Commands, edits and external actions are blocked. Choose before starting a Meerkat conversation.",
    icon: LockIcon,
  },
  "approval-required": {
    label: "Supervised",
    description: "Ask before commands and file changes.",
    icon: LockIcon,
  },
  "auto-accept-edits": {
    label: "Auto-accept edits",
    description: "Auto-approve edits, ask before other actions.",
    icon: PenLineIcon,
  },
  auto: {
    label: "Auto",
    description: "Supported providers approve routine actions; others still ask.",
    icon: SparklesIcon,
  },
  "full-access": {
    label: "Full access",
    description: "Allow commands and edits without prompts.",
    icon: LockOpenIcon,
  },
};

export const runtimeModeOptions = Object.keys(runtimeModeConfig) as RuntimeMode[];

export function runtimeModeDescription(mode: RuntimeMode, meerkat = false): string {
  return meerkat && mode === "approval-required"
    ? "Ask before every tool call, including reads. Applies to this thread and its workers."
    : runtimeModeConfig[mode].description;
}
