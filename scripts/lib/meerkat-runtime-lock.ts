export function lockedMeerkatReleases(lock: string) {
  const releases: Record<string, string> = {};
  for (const block of lock.split("[[package]]")) {
    const name = /^name = "([^"]+)"$/m.exec(block)?.[1];
    if (name !== "meerkat" && name !== "meerkat-mobkit") continue;
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
  if (!releases.meerkat || !releases["meerkat-mobkit"])
    throw new Error("Consumer Cargo.lock must contain released Meerkat and MobKit packages.");
  return releases;
}
