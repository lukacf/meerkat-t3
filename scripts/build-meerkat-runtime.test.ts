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
  it("rejects path, unpinned git, missing and split dependency sets", () => {
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

const revision = "a".repeat(40);
const gitEntry = (name: string, rev = revision) =>
  entry(name, "0.9.2")
    .replace(
      "registry+https://github.com/rust-lang/crates.io-index",
      `git+https://github.com/lukacf/meerkat?rev=${rev}#${rev}`,
    )
    .replace(/^checksum = .+$/m, "");
it("accepts one exact upstream Core pin with registry Meta", () => {
  expect(
    lockedMeerkatReleases(
      gitEntry("meerkat") + gitEntry("meerkat-sqlite") + entry("meerkat-meta", "0.9.2"),
    ),
  ).toEqual({ meerkat: "0.9.2", mobkit: { package: "meerkat-meta", version: "0.9.2" } });
});
it("rejects mixed Core sources, mutable pins and a Git Meta override", () => {
  for (const core of [
    gitEntry("meerkat") + entry("meerkat-sqlite", "0.9.2"),
    gitEntry("meerkat") + gitEntry("meerkat-sqlite", "b".repeat(40)),
    gitEntry("meerkat").replace("?rev=", "?branch="),
    gitEntry("meerkat").replace(/#[a-f0-9]+/, "#" + "b".repeat(40)),
    gitEntry("meerkat").replace("lukacf/meerkat", "unreviewed/meerkat"),
  ])
    expect(() => lockedMeerkatReleases(core + entry("meerkat-meta", "0.9.2"))).toThrow();
  expect(() => lockedMeerkatReleases(gitEntry("meerkat") + gitEntry("meerkat-meta"))).toThrow();
});
