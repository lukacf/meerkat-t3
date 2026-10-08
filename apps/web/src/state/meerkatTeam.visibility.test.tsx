import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { PresentationVisibility } from "../hooks/usePresentationVisibility";
vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("@t3tools/client-runtime/state/meerkatTeam", () => ({
  createMeerkatTeamEnvironmentAtoms: () => ({}),
}));
import { useVisibleTeamRefresh } from "./meerkatTeam";
import type { EnvironmentQueryView } from "./query";
let renderer: ReactTestRenderer | undefined;
const refresh = vi.fn();
const query: EnvironmentQueryView<null> = {
  data: null,
  dataUpdatedAt: null,
  error: null,
  isPending: false,
  isSuccess: true,
  refresh,
};
function Observer({ pending = false }: { pending?: boolean }) {
  useVisibleTeamRefresh({ ...query, isPending: pending }, true);
  return null;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
  vi.stubGlobal("window", globalThis);
  vi.useFakeTimers();
  refresh.mockReset();
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("keeps both wide panes observing but suspends the hidden compact pane", async () => {
  const view = (visible: boolean) => (
    <>
      <Observer />
      <PresentationVisibility value={visible}>
        <Observer />
      </PresentationVisibility>
    </>
  );
  await act(async () => {
    renderer = create(view(true));
  });
  expect(vi.getTimerCount()).toBe(2);
  await act(async () => {
    renderer!.update(view(false));
  });
  expect(vi.getTimerCount()).toBe(1);
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(refresh).toHaveBeenCalledOnce();
  await act(async () => {
    renderer!.update(view(true));
  });
  expect(vi.getTimerCount()).toBe(1);
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(refresh).toHaveBeenCalledTimes(2);
});
it("does not admit another refresh while a prior observation is pending", async () => {
  await act(async () => {
    renderer = create(<Observer pending />);
  });
  await act(async () => vi.advanceTimersByTimeAsync(20000));
  expect(refresh).not.toHaveBeenCalled();
  await act(async () => {
    renderer!.update(<Observer />);
  });
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(refresh).toHaveBeenCalledOnce();
});
