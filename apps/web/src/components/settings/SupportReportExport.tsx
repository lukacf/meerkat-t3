import { useState } from "react";
import type { DesktopDiagnosticsExportResult } from "@t3tools/contracts";
import { Button } from "../ui/button";

/** Native IPC only: collecting this report never depends on a server or editor. */
export function SupportReportExport() {
  const exportReport = window.desktopBridge?.exportDiagnostics;
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<DesktopDiagnosticsExportResult | null>(null);
  if (!exportReport) return null;

  async function save() {
    if (pending || !exportReport) return;
    setPending(true);
    setResult(null);
    try {
      setResult(await exportReport());
    } catch {
      setResult({ status: "failed", filePath: null, errorCategory: "report-unavailable" });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-3 rounded-xl border border-border/60 p-4 sm:p-5">
      <div className="space-y-1">
        <h2 className="text-sm font-medium text-foreground">Desktop support report</h2>
        <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
          Save this Mac&apos;s app version, bundled runtime versions, and local backend status.
          Conversations, credentials, paths, raw logs, and remote computers are excluded. Nothing is
          sent automatically.
        </p>
      </div>
      <Button size="sm" variant="outline" disabled={pending} onClick={() => void save()}>
        {pending ? "Saving report..." : "Export support report"}
      </Button>
      <p className="text-xs text-muted-foreground">
        If the workspace cannot load, use Help &gt; Export support report in the desktop menu.
      </p>
      <div aria-live="polite" className="text-xs">
        {result?.status === "saved" ? (
          <p className="break-all">
            Saved to {result.filePath}. Send this file to the person who provided your build.
          </p>
        ) : result?.status === "failed" ? (
          <p className="text-destructive">
            The report could not be saved. Try another folder, or use the desktop Help menu.
          </p>
        ) : null}
      </div>
    </div>
  );
}
