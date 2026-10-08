"use client";

import { useId } from "react";
import { useCommitOnBlur } from "~/hooks/useCommitOnBlur";
import { cn } from "~/lib/utils";
import { Input, type InputProps } from "./input";

export type DraftInputProps = Omit<InputProps, "value" | "onChange" | "defaultValue"> & {
  readonly value: string;
  readonly onCommit: (next: string) => void | Promise<boolean>;
  readonly normalize?: (next: string) => string;
};

/** Buffer edits until blur or Enter, retaining an unacknowledged async save for retry. */
export function DraftInput({ value, onCommit, normalize, className, ...rest }: DraftInputProps) {
  const statusId = useId();
  const { isPending, hasFailed, hasUncommittedChanges, ...bag } = useCommitOnBlur(
    value,
    onCommit,
    normalize,
  );
  const status = isPending
    ? "Saving..."
    : hasFailed
      ? "Could not save. Press Enter or leave this field to retry."
      : hasUncommittedChanges
        ? "Unsaved changes. Press Enter or leave this field to save."
        : "";
  return (
    <span className={cn("inline-flex w-full min-w-0 flex-col", className)}>
      <Input
        {...rest}
        {...bag}
        aria-busy={isPending || rest["aria-busy"]}
        aria-invalid={hasFailed || rest["aria-invalid"]}
        aria-describedby={[rest["aria-describedby"], statusId].filter(Boolean).join(" ")}
      />
      <span
        id={statusId}
        role="status"
        aria-atomic="true"
        className="text-xs text-muted-foreground"
      >
        {status}
      </span>
    </span>
  );
}
