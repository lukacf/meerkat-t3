import { describe, expect, it } from "vite-plus/test";
import { lockedMeerkatReleases } from "./lib/meerkat-runtime-lock.ts";
const entry = (name: string, version = "0.8.42") =>
  `[[package]]\nname = "${name}"\nversion = "${version}"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "${"a".repeat(64)}"\n`;
describe("Meerkat runtime provisioning lock", () => {
  it("uses exact released dependency identity from the consumer lock", () => {
    expect(lockedMeerkatReleases(entry("meerkat") + entry("meerkat-mobkit"))).toEqual({
      meerkat: "0.8.42",
      "meerkat-mobkit": "0.8.42",
    });
  });
  it("rejects path, git, missing and split dependency sets", () => {
    for (const lock of [
      entry("meerkat"),
      entry("meerkat") + entry("meerkat-mobkit").replace('source = "registry+', 'source = "git+'),
      entry("meerkat") + entry("meerkat-mobkit") + entry("meerkat", "0.1.0"),
    ])
      expect(() => lockedMeerkatReleases(lock)).toThrow();
  });
});
