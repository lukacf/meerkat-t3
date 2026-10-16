import { describe, expect, it } from "vite-plus/test";
import { lockedMeerkatReleases } from "./lib/meerkat-runtime-lock.ts";
const entry = (name: string, version = "0.8.42") =>
  `[[package]]\nname = "${name}"\nversion = "${version}"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "${"a".repeat(64)}"\n`;
describe("Meerkat runtime provisioning lock", () => {
  it("uses exact released legacy dependency identity from the consumer lock", () => {
    expect(lockedMeerkatReleases(entry("meerkat") + entry("meerkat-mobkit"))).toEqual({
      meerkat: "0.8.42",
      mobkit: { package: "meerkat-mobkit", version: "0.8.42" },
    });
  });
  it("resolves the published 0.9 package behind the consumer's MobKit alias", () => {
    expect(
      lockedMeerkatReleases(entry("meerkat", "0.9.0") + entry("meerkat-meta", "0.9.0")),
    ).toEqual({
      meerkat: "0.9.0",
      mobkit: { package: "meerkat-meta", version: "0.9.0" },
    });
  });
  it("rejects path, git, missing and split dependency sets", () => {
    for (const lock of [
      entry("meerkat"),
      entry("meerkat") + entry("meerkat-mobkit").replace('source = "registry+', 'source = "git+'),
      entry("meerkat") + entry("meerkat-mobkit") + entry("meerkat", "0.1.0"),
      entry("meerkat", "0.9.0") + entry("meerkat-meta", "0.9.0").replace(/^checksum = .+$/m, ""),
      entry("meerkat", "0.9.0") + entry("meerkat-meta", "0.9.0") + entry("meerkat-meta", "0.9.0"),
    ])
      expect(() => lockedMeerkatReleases(lock)).toThrow();
  });
  it("rejects both package names even when their versions match", () => {
    for (const packages of [
      ["meerkat-meta", "meerkat-mobkit"],
      ["meerkat-mobkit", "meerkat-meta"],
    ])
      expect(() =>
        lockedMeerkatReleases(
          entry("meerkat", "0.9.0") + packages.map((name) => entry(name, "0.9.0")).join(""),
        ),
      ).toThrow("Both meerkat-meta and meerkat-mobkit");
  });
});
