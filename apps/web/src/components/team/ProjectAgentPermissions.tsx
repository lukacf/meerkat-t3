import type { MeerkatProjectAgentAccessMode } from "@t3tools/contracts";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

export function projectAgentPermissionLabel(mode: MeerkatProjectAgentAccessMode | undefined) {
  return mode === "read-only"
    ? "Read-only"
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
          if (mode === "read-only" || mode === "full-access") onChange(mode);
        }}
      >
        <SelectTrigger aria-label="New agent permissions">
          <SelectValue>{projectAgentPermissionLabel(value)}</SelectValue>
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value="read-only">Read-only</SelectItem>
          <SelectItem value="full-access">Full access</SelectItem>
        </SelectPopup>
      </Select>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {value === "read-only"
          ? "Can inspect project files. File changes, commands, and sending messages to peers are blocked. Choose Full access for a collaborating specialist."
          : "Can change files, run commands, and use tools without asking for approval, including during its initial study."}{" "}
        Permissions stay with this conversation. Create a new agent to choose a different mode.
      </p>
    </div>
  );
}
