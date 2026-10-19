import { pinnedGitSource } from "./pinned-git-source.mjs";

export function lockedMeerkatReleases(lock: string) {
  const releases: Record<string, string> = {};
  const coreSources = new Set<string>();
  for (const block of lock.split("[[package]]")) {
    const name = /^name = "([^"]+)"$/m.exec(block)?.[1];
    if (!name || (name !== "meerkat" && !name.startsWith("meerkat-"))) continue;
    if (name.startsWith("meerkat-desktop-")) continue;
    const version = /^version = "([^"]+)"$/m.exec(block)?.[1];
    const source = /^source = "([^"]+)"$/m.exec(block)?.[1];
    const corePackage = name !== "meerkat-meta" && name !== "meerkat-mobkit";
    const git = source?.startsWith("git+") ? pinnedGitSource(source) : undefined;
    if (
      !version ||
      (git
        ? !corePackage ||
          git.repository !== "https://github.com/lukacf/meerkat" ||
          /^checksum = /m.test(block)
        : !source?.startsWith("registry+") || !/^checksum = "[a-f0-9]{64}"$/m.test(block))
    )
      throw new Error(
        `${name} must use a checksum-pinned registry package or an exact upstream Core commit.`,
      );
    if (corePackage) coreSources.add(source!);
    if (releases[name])
      throw new Error(`Multiple ${name} versions are not a supported native runtime bundle.`);
    releases[name] = version;
  }
  if (coreSources.size > 1)
    throw new Error("Mixed Meerkat Core sources are not a supported native runtime bundle.");
  // MobKit ships as meerkat-meta from 0.9. Cargo.lock records the package
  // name, even when the consumer retains a meerkat-mobkit dependency alias.
  const mobkitPackages = (["meerkat-meta", "meerkat-mobkit"] as const).filter(
    (name) => releases[name] !== undefined,
  );
  if (mobkitPackages.length > 1)
    throw new Error("Both meerkat-meta and meerkat-mobkit are present in the consumer Cargo.lock.");
  const mobkitPackage = mobkitPackages[0];
  if (!releases.meerkat || !mobkitPackage)
    throw new Error("Consumer Cargo.lock must contain released Meerkat and MobKit packages.");
  return {
    meerkat: releases.meerkat,
    mobkit: { package: mobkitPackage, version: releases[mobkitPackage]! },
  };
}
