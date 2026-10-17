import type { MeerkatProjectAgentAccessMode } from "@t3tools/contracts";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

export function projectAgentPermissionLabel(mode: MeerkatProjectAgentAccessMode | undefined) {
  return mode === "read-only"
    ? "Read-only"
    : mode === "read-and-collaborate"
      ? "Read and collaborate"
      : mode === "repository-read-only"
        ? "Repository read-only"
        : mode === "full-access"
          ? "Full access"
          : "Permissions unavailable";
}

export function ProjectAgentPermissions({
  value,
  onChange,
  disabled = false,
}: {
  value: MeerkatProjectAgentAccessMode;
  onChange: (mode: MeerkatProjectAgentAccessMode) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-2">
      <span className="text-sm">Permissions</span>
      <Select
        value={value}
        disabled={disabled}
        onValueChange={(mode) => {
          if (mode === "read-only" || mode === "read-and-collaborate" || mode === "full-access")
            onChange(mode);
        }}
      >
        <SelectTrigger aria-label="New agent permissions">
          <SelectValue>{projectAgentPermissionLabel(value)}</SelectValue>
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value="read-and-collaborate">Read and collaborate</SelectItem>
          <SelectItem value="read-only">Read-only</SelectItem>
          <SelectItem value="full-access">Full access</SelectItem>
        </SelectPopup>
      </Select>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {value === "read-and-collaborate"
          ? "Can inspect project files and exchange messages with connected peers. File changes, commands, browser control, and external tools are blocked."
          : value === "read-only"
            ? "Can inspect project files and answer you directly. File changes, commands, and sending messages to peers are blocked."
            : "Can change files, run commands, and use tools without asking for approval, including during its initial study."}{" "}
        Permissions stay with this conversation. Create a new agent to choose a different mode.
      </p>
    </div>
  );
}
