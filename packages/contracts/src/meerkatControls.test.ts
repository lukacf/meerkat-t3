import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  MeerkatAuthActionInput,
  MeerkatAuthConnection,
  MeerkatAuthFlow,
  MeerkatAuthOverview,
  MeerkatAuthScope,
} from "./meerkatControls.ts";

const scope = { projectId: "project", instanceId: "native" };
const threadTarget = { threadId: "thread", expectedCwd: "/worktrees/thread" };

describe("Meerkat thread account scope", () => {
  it("preserves native default activation separately from authentication success", () => {
    const decode = Schema.decodeUnknownSync(MeerkatAuthFlow);
    const connected = { flowId: null, authorizeUrl: null, status: "connected", message: null };
    expect(decode(connected)).toEqual(connected);
    expect(decode({ ...connected, credentialsSaved: true }).credentialsSaved).toBe(true);
    expect(() => decode({ ...connected, credentialsSaved: "yes" })).toThrow();
    for (const defaultActivation of [
      { status: "updated", providers: ["openai", "anthropic"] },
      { status: "unchanged", providers: [] },
      { status: "needs_selection", providers: [] },
    ]) {
      expect(decode({ ...connected, defaultActivation })).toEqual({
        ...connected,
        defaultActivation,
      });
    }
    for (const defaultActivation of [
      { status: "selected", providers: ["openai"] },
      { status: "updated", providers: "openai" },
      { status: "updated", providers: [""] },
      { status: "needs_selection" },
    ]) {
      expect(() => decode({ ...connected, defaultActivation })).toThrow();
    }
  });

  it("preserves native shared credential identity without requiring it from older gateways", () => {
    const decode = Schema.decodeUnknownSync(MeerkatAuthConnection);
    const account = {
      provider: "openai",
      displayName: "GitHub Copilot",
      realmId: "global",
      bindingId: "copilot-openai",
      profileId: "work",
      source: "managed_store",
      state: "connected",
      supportsInteractiveLogin: true,
    };
    expect(decode(account)).toEqual(account);
    expect(decode({ ...account, state: "unknown" }).state).toBe("unknown");
    const shared = { ...account, credentialAccount: { realm: "global", account: "work-copilot" } };
    expect(decode(shared)).toEqual(shared);
    expect(decode({ ...shared, supportsRemoval: true }).supportsRemoval).toBe(true);
    expect(decode({ ...shared, supportsRemoval: false }).supportsRemoval).toBe(false);
    expect(() => decode({ ...shared, supportsRemoval: "yes" })).toThrow();
    expect(() => decode({ ...account, credentialAccount: { account: "work-copilot" } })).toThrow();
  });

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
