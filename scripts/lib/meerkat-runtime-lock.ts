export function lockedMeerkatReleases(lock: string) {
  const releases: Record<string, string> = {};
  for (const block of lock.split("[[package]]")) {
    const name = /^name = "([^"]+)"$/m.exec(block)?.[1];
    if (name !== "meerkat" && name !== "meerkat-meta" && name !== "meerkat-mobkit") continue;
    const version = /^version = "([^"]+)"$/m.exec(block)?.[1];
    if (
      !version ||
      !/^source = "registry\+/m.test(block) ||
      !/^checksum = "[a-f0-9]{64}"$/m.test(block)
    )
      throw new Error(`${name} must come from a checksum-pinned released registry package.`);
    if (releases[name])
      throw new Error(`Multiple ${name} versions are not a supported native runtime bundle.`);
    releases[name] = version;
  }
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
