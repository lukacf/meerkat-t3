import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  MeerkatAuthActionInput,
  MeerkatAuthOverview,
  MeerkatAuthScope,
} from "./meerkatControls.ts";

const scope = { projectId: "project", instanceId: "native" };
const threadTarget = { threadId: "thread", expectedCwd: "/worktrees/thread" };

describe("Meerkat thread account scope", () => {
  it("preserves project-only clients and the complete thread identity", () => {
    const decode = Schema.decodeUnknownSync(MeerkatAuthScope);
    expect(decode(scope)).toEqual(scope);
    expect(decode({ ...scope, threadTarget })).toEqual({ ...scope, threadTarget });
    const action = { ...scope, threadTarget, provider: "openai", action: "start" };
    expect(Schema.decodeUnknownSync(MeerkatAuthActionInput)(action)).toEqual(action);
  });

  it("rejects incomplete thread targets instead of converting them into project requests", () => {
    const decode = Schema.decodeUnknownSync(MeerkatAuthScope);
    for (const invalid of [
      null,
      {},
      { threadId: "thread" },
      { expectedCwd: "/worktrees/thread" },
      { ...threadTarget, expectedCwd: "" },
    ]) {
      expect(() => decode({ ...scope, threadTarget: invalid })).toThrow();
    }
  });

  it("keeps validated workspace metadata optional for old auth responses", () => {
    const decode = Schema.decodeUnknownSync(MeerkatAuthOverview);
    expect(decode({ connections: [] })).toEqual({ connections: [] });
    const response = {
      connections: [],
      workspace: { projectId: "project", threadId: "thread", cwd: "/worktrees/thread" },
    };
    expect(decode(response)).toEqual(response);
    expect(() =>
      decode({ connections: [], workspace: { projectId: "project", threadId: "thread" } }),
    ).toThrow();
  });
});
