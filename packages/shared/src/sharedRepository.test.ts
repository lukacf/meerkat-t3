import { describe, expect, it } from "vite-plus/test";
import { canonicalSharedRepository } from "./sharedRepository.ts";

describe("canonical shared repository", () => {
  it("matches HTTPS and SSH identities without matching unrelated forks", () => {
    const expected = "github.com/example/api";
    for (const remote of [
      "git@github.com:Example/API.git",
      "https://github.com/example/api",
      "ssh://git@github.com:22/Example/API.git",
      expected,
    ])
      expect(canonicalSharedRepository(remote)).toBe(expected);
    expect(canonicalSharedRepository("https://github.com/another/api")).not.toBe(expected);
  });
  it("preserves non-default ports and case-sensitive paths", () => {
    expect(canonicalSharedRepository("ssh://git@forge.example:2222/Team/API.git")).toBe(
      "forge.example:2222/Team/API",
    );
    expect(canonicalSharedRepository("https://forge.example:8443/Team/API")).toBe(
      "forge.example:8443/Team/API",
    );
    expect(canonicalSharedRepository("https://forge.example/Team/API")).not.toBe(
      canonicalSharedRepository("https://forge.example/team/api"),
    );
  });
  it("supports bounded long forge paths without accepting unbounded identities", () => {
    const canonical = `forge.example/Team/${"nested/".repeat(60)}API`;
    expect(canonical.length).toBeGreaterThan(200);
    expect(canonicalSharedRepository(`https://${canonical}`)).toBe(canonical);
    expect(() => canonicalSharedRepository(`forge.example/Team/${"a".repeat(2048)}`)).toThrow(
      "too long",
    );
  });
  it.each([
    "/Users/ada/api",
    "../api",
    "api",
    "file:///tmp/org/api",
    "https://user:secret@github.com/org/api",
    "https://github.com/org/api?token=secret",
    "https://github.com/org/../api",
    "https://github.com/org/%2e%2e/api",
    "https://github.com/org/api#branch",
    "https://github.com/org//api",
  ])("rejects ambiguous or local identity %s", (remote) => {
    expect(() => canonicalSharedRepository(remote)).toThrow();
  });
});
