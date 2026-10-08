import { DesktopDiagnosticsExportResultSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as DesktopDiagnostics from "../../diagnostics/DesktopDiagnostics.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as IpcChannels from "../channels.ts";

export const exportDiagnostics = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.EXPORT_DIAGNOSTICS_CHANNEL,
  payload: Schema.Void,
  result: DesktopDiagnosticsExportResultSchema,
  handler: Effect.fn("desktop.ipc.diagnostics.export")(function* () {
    const diagnostics = yield* DesktopDiagnostics.DesktopDiagnostics;
    return yield* diagnostics.exportReport;
  }),
});
