import { assert, describe, it } from "@effect/vitest";
import { resolveMeerkatReleaseRepository } from "./meerkatDistribution.ts";

describe("Meerkat release repository", () => {
  it("accepts only a canonical explicitly named fork repository", () => {
    assert.deepEqual(resolveMeerkatReleaseRepository(" example/meerkat-desktop "), { owner: "example", repo: "meerkat-desktop" });
    for (const value of [undefined, null, "", "pingdotgg/t3code", "PingDotGG/T3Code", "pingdotgg/t3code.git", "https://github.com/example/meerkat", "example/meerkat/extra", "example/../t3code", "user@github.com/meerkat", "example/meerkat?foo=bar"]) {
      assert.isNull(resolveMeerkatReleaseRepository(value), String(value));
    }
  });
});
