import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { SkillInlineText } from "./SkillInlineText";

const first = {
  name: "review",
  displayName: "review (first-source)",
  path: "meerkat-skill://78249a26-13e0-4f13-a9c7-a96c5d258501/review",
};
const second = {
  name: "review",
  displayName: "review (second-source)",
  path: "meerkat-skill://78249a26-13e0-4f13-a9c7-a96c5d258502/review",
};
const text = `Queued [review](${second.path}) and $review`;
let renderer: ReactTestRenderer | undefined;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

it("uses the exact selected catalog source and preserves its serialized copy value through catalog refresh", () => {
  act(() => {
    renderer = create(<SkillInlineText text={text} skills={[first, second]} />);
  });
  const content = () => JSON.stringify(renderer!.toJSON());
  expect(content()).toContain(second.displayName);
  expect(content()).not.toContain(first.displayName);
  expect(content()).toContain("and $review");
  const chip = () =>
    renderer!.root.findByProps({ "data-markdown-copy": `[review](${second.path})` });
  expect(chip()).toBeDefined();
  act(() => renderer!.update(<SkillInlineText text={text} skills={[first]} />));
  expect(content()).toContain("review (78249a26-13e0-4f13-a9c7-a96c5d258502)");
  expect(content()).not.toContain(first.displayName);
  expect(chip()).toBeDefined();
  act(() => renderer!.update(<SkillInlineText text={text} skills={[second, first]} />));
  expect(content()).toContain(second.displayName);
});
