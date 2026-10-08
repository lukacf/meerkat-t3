import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { GitIdentityUpdateInput } from "./git.ts";
const decode = Schema.decodeUnknownSync(GitIdentityUpdateInput);
describe("explicit repository author input", () => {
  it("accepts a user-chosen name and private email", () => {
    const input = {
      cwd: "/workspace",
      name: "Sam Developer",
      email: "123+sam@users.noreply.github.com",
    };
    expect(decode(input)).toEqual(input);
  });
  it.each(["", "   ", "\nOther Author", "Name\rAlias", "Name\0Alias", "Name\n"])(
    "rejects an invalid identity value %j",
    (name) => {
      expect(() => decode({ cwd: "/workspace", name, email: "sam@example.com" })).toThrow();
    },
  );
});
