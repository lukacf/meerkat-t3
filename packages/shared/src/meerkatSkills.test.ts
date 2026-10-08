import { describe, expect, it } from "vite-plus/test";
import { collectComposerInlineTokens } from "./composerInlineTokens.ts";
import {
  extractMeerkatSkillSelections,
  meerkatSkillHref,
  parseMeerkatSkillHref,
  serializeProviderSkillSelection,
  extractMeerkatConsoleSkillSelections,
} from "./meerkatSkills.ts";

const first = { source_uuid: "b3fdcd90-cb8c-40c2-aee5-c1aba30a9b64", skill_name: "review" };
const second = { ...first, source_uuid: "4fa3e1a2-5b6c-47d8-9012-3456789abcde" };
const pick = (key: typeof first) =>
  serializeProviderSkillSelection({ name: key.skill_name, path: meerkatSkillHref(key) });

describe("native skill selection", () => {
  it("carries console selections on new turns while refusing them for steering", () => {
    const text = `Use ${pick(first)} and ${pick(second)}`;
    expect(extractMeerkatConsoleSkillSelections(text, "queue")).toEqual({
      text,
      skillReferences: [first, second],
    });
    expect(() => extractMeerkatConsoleSkillSelections(text, "steer")).toThrow(
      "Skills start with a new turn",
    );
    expect(extractMeerkatConsoleSkillSelections("Use $review please", "steer")).toEqual({
      text: "Use $review please",
      skillReferences: [],
    });
    expect(() =>
      extractMeerkatConsoleSkillSelections("[review](meerkat-skill://missing/review)", "queue"),
    ).toThrow("selection is invalid");
  });

  it("keeps exact source identity and operator text across duplicate names and repeated picks", () => {
    const text = `Use ${pick(first)} and ${pick(second)}. Repeat ${pick(first)}`;
    expect(extractMeerkatSkillSelections(text)).toEqual({ text, skillReferences: [first, second] });
    expect(
      collectComposerInlineTokens(text).map((token) => token.type === "skill" && token.path),
    ).toEqual([meerkatSkillHref(first), meerkatSkillHref(second), meerkatSkillHref(first)]);
  });
  it("preserves Unicode operator text around a valid native slug", () => {
    const key = { ...first, skill_name: "review-2" };
    expect(parseMeerkatSkillHref(meerkatSkillHref(key))).toEqual(key);
    const text = `日本語: ${pick(key)} please`;
    expect(extractMeerkatSkillSelections(text)).toEqual({ text, skillReferences: [key] });
  });
  it("refuses damaged native selections while preserving other providers' name syntax", () => {
    for (const text of [
      "[review](meerkat-skill://missing/review)",
      "[review](meerkat-skill://b3fdcd90-cb8c-40c2-aee5-c1aba30a9b64/%ZZ)",
    ]) {
      expect(() => extractMeerkatSkillSelections(text)).toThrow("selection is invalid");
    }
    expect(
      serializeProviderSkillSelection({ name: "review", path: "/skills/review/SKILL.md" }),
    ).toBe("$review");
    expect(extractMeerkatSkillSelections("Use $review please")).toEqual({
      text: "Use $review please",
      skillReferences: [],
    });
  });
});
