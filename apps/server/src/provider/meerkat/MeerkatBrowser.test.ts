import { expect, it, afterEach } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { configureMeerkatThreadBrowser } from "./MeerkatBrowser.ts";
import {
  setMcpProviderSession,
  clearAllMcpProviderSessions,
} from "../../mcp/McpProviderSession.ts";
import type { MeerkatGatewayClient } from "./MeerkatGatewayClient.ts";
afterEach(clearAllMcpProviderSessions);
it("forwards only the owning preview credential and revokes absent capability", async () => {
  const calls: unknown[] = [];
  const client = {
    request: async (method: string, params: unknown) => {
      calls.push({ method, params });
    },
  } as unknown as MeerkatGatewayClient;
  const threadId = ThreadId.make("thread"),
    scope = { mobId: "mob", stateRoot: "/state", projectPath: "/project" };
  await configureMeerkatThreadBrowser(client, threadId, scope);
  setMcpProviderSession({
    threadId,
    environmentId: EnvironmentId.make("env"),
    providerInstanceId: ProviderInstanceId.make("meerkat"),
    providerSessionId: "native",
    endpoint: "http://127.0.0.1:1234/mcp",
    authorizationHeader: "Bearer fixture",
    capabilities: new Set(["preview"]),
  });
  await configureMeerkatThreadBrowser(client, threadId, scope);
  expect(calls).toEqual([
    { method: "mobs.v1.browserConfigure", params: { ...scope, enabled: false } },
    {
      method: "mobs.v1.browserConfigure",
      params: {
        ...scope,
        enabled: true,
        hostThreadId: threadId,
        hostSessionId: "native",
        endpoint: "http://127.0.0.1:1234/mcp",
        authorizationHeader: "Bearer fixture",
      },
    },
  ]);
});
