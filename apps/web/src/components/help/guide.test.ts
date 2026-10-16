import { describe, expect, it } from "vite-plus/test";
import { GUIDE_TOPICS, guideHeadingId, resolveGuideLink, resolveGuideTopic } from "./guide";

describe("bundled guide navigation", () => {
  it("opens a safe first topic for unknown or malformed links", () => {
    expect(resolveGuideTopic("accounts")).toBe("accounts");
    expect(resolveGuideTopic("../../settings.json")).toBe("start");
    expect(resolveGuideTopic(["updates"])).toBe("start");
  });

  it("keeps documentation links and anchors in the offline guide", () => {
    expect(resolveGuideLink("agents.md#follow-up-messages")).toEqual({
      topic: "agents",
      hash: "follow-up-messages",
    });
    expect(resolveGuideLink("troubleshooting.md")).toEqual({ topic: "recovery", hash: "" });
    expect(guideHeadingId("Follow-up messages")).toBe("follow-up-messages");
    expect(resolveGuideLink("https://example.com/agents.md")).toBeNull();
  });

  it("bundles every relative destination linked from a guide topic", () => {
    for (const entry of GUIDE_TOPICS) {
      for (const [, href] of entry.text.matchAll(/\]\(([^)]+)\)/g)) {
        if (!href || /^https?:\/\//.test(href)) continue;
        const target = resolveGuideLink(href);
        expect(target, `${entry.file}: ${href}`).not.toBeNull();
        if (target?.hash) {
          const destination = GUIDE_TOPICS.find((topic) => topic.id === target.topic);
          const headingIds = [...(destination?.text ?? "").matchAll(/^#{2,3} (.+)$/gm)].map(
            (match) => guideHeadingId(match[1] ?? ""),
          );
          expect(headingIds, `${entry.file}: ${href}`).toContain(target.hash);
        }
      }
    }
  });
});
