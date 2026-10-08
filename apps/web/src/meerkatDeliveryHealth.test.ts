import { expect, it } from "vite-plus/test";
import { meerkatDeliveryHealth } from "./meerkatDeliveryHealth";
it("keeps a failed delivery visible until its own recovery event arrives", () => {
  const failure = {
    kind: "runtime.warning",
    payload: { detail: { kind: "meerkat.delivery.health", status: "error" } },
  };
  expect(
    meerkatDeliveryHealth([
      failure,
      { kind: "runtime.warning", payload: { message: "Other warning" } },
    ]),
  ).toContain("waiting to sync");
  expect(
    meerkatDeliveryHealth([
      failure,
      {
        kind: "runtime.warning",
        payload: { detail: { kind: "meerkat.delivery.health", status: "ready" } },
      },
    ]),
  ).toBeNull();
  expect(meerkatDeliveryHealth([{ kind: "runtime.warning", payload: null }])).toBeNull();
});
