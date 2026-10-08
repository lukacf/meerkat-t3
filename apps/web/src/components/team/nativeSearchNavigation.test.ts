import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { agentSearchMatchKey, type EnvironmentAgentSearchMatch } from "../../state/meerkatSearch";
import { nativeSearchDestination, validateNativeSearchLocation } from "./nativeSearchNavigation";

const match: EnvironmentAgentSearchMatch = {
  environmentId: EnvironmentId.make("local"),
  projectId: ProjectId.make("project-a"),
  projectTitle: "Repeated",
  instanceId: ProviderInstanceId.make("native"),
  agentRef: "ref-a",
  projectAgentId: "definition-a",
  label: "Reviewer",
  message: {
    sessionId: "native-session",
    storeRevision: "7",
    offset: 823,
    source: "assistant",
    snippet: "Match",
  },
};
describe("exact native search navigation", () => {
  it("keeps the historical incarnation and exact message when opening a project specialist", () => {
    expect(nativeSearchDestination(match)).toEqual({
      to: "/$environmentId/agents/$agentId",
      params: { environmentId: "local", agentId: "definition-a" },
      search: {
        project: "project-a",
        nativeAgent: "ref-a",
        nativeInstance: "native",
        nativeSession: "native-session",
        nativeRevision: "7",
        nativeOffset: 823,
      },
    });
  });
  it("opens a worker in its owning thread and never collides across environments", () => {
    const worker = { ...match, threadId: ThreadId.make("thread-a") };
    expect(nativeSearchDestination(worker)).toMatchObject({
      to: "/$environmentId/$threadId",
      search: { member: "ref-a", nativeOffset: 823 },
    });
    expect(agentSearchMatchKey(worker)).not.toBe(
      agentSearchMatchKey({ ...worker, environmentId: EnvironmentId.make("remote") }),
    );
    expect(agentSearchMatchKey(worker)).not.toBe(
      agentSearchMatchKey({ ...worker, projectId: ProjectId.make("other") }),
    );
  });
  it("requires a complete exact message target and validates URL number coercion", () => {
    expect(
      validateNativeSearchLocation({
        nativeAgent: "ref-a",
        nativeSession: "session",
        nativeRevision: "7",
        nativeOffset: "823",
      }),
    ).toEqual({
      nativeAgent: "ref-a",
      nativeSession: "session",
      nativeRevision: "7",
      nativeOffset: 823,
    });
    for (const nativeOffset of [-1, "bad", Infinity, 1.2])
      expect(
        validateNativeSearchLocation({
          nativeAgent: "ref-a",
          nativeSession: "session",
          nativeRevision: "7",
          nativeOffset,
        }),
      ).toEqual({ nativeAgent: "ref-a" });
  });
});
