import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { DesktopDiagnosticsExportResult } from "@t3tools/contracts";

vi.mock("../ui/button", () => ({ Button: "button" }));
import { SupportReportExport } from "./SupportReportExport";

let renderer: ReactTestRenderer | null = null;
const exportDiagnostics = vi.fn<() => Promise<DesktopDiagnosticsExportResult>>();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { desktopBridge: { exportDiagnostics } });
  exportDiagnostics.mockReset();
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});
const render = () =>
  act(() => {
    renderer = create(<SupportReportExport />);
  });
const text = () => JSON.stringify(renderer?.toJSON());

describe("SupportReportExport", () => {
  it("saves through desktop IPC and shows the file location", async () => {
    exportDiagnostics.mockResolvedValue({
      status: "saved",
      filePath: "/chosen/support.json",
      errorCategory: null,
    });
    render();
    await act(async () => {
      renderer!.root.findByType("button").props.onClick();
    });
    expect(exportDiagnostics).toHaveBeenCalledOnce();
    expect(text()).toContain("/chosen/support.json");
    expect(text()).toContain("Nothing is sent automatically.");
  });

  it("treats cancellation quietly and does not imply a saved report", async () => {
    exportDiagnostics.mockResolvedValue({
      status: "cancelled",
      filePath: null,
      errorCategory: null,
    });
    render();
    await act(async () => {
      renderer!.root.findByType("button").props.onClick();
    });
    expect(text()).not.toContain("Saved to");
    expect(text()).not.toContain("could not be saved");
  });

  it("does not display raw IPC errors or credentials", async () => {
    exportDiagnostics.mockRejectedValue(new Error("PRIVATE_TOKEN /private/path"));
    render();
    await act(async () => {
      renderer!.root.findByType("button").props.onClick();
    });
    expect(text()).toContain("The report could not be saved");
    expect(text()).not.toContain("PRIVATE_TOKEN");
    expect(renderer!.root.findByType("button").props.disabled).toBe(false);
  });

  it("disables repeat exports until the native picker resolves", async () => {
    let finish!: (value: DesktopDiagnosticsExportResult) => void;
    exportDiagnostics.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render();
    act(() => renderer!.root.findByType("button").props.onClick());
    expect(renderer!.root.findByType("button").props.disabled).toBe(true);
    await act(async () => {
      finish({ status: "cancelled", filePath: null, errorCategory: null });
    });
    expect(renderer!.root.findByType("button").props.disabled).toBe(false);
  });

  it("does not offer an unsupported export in browser-only clients", () => {
    vi.stubGlobal("window", {});
    render();
    expect(renderer?.toJSON()).toBeNull();
  });
});
