import type { ThreadId } from "@t3tools/contracts";
import { readMcpProviderSession } from "../../mcp/McpProviderSession.ts";
import type { MeerkatGatewayClient } from "./MeerkatGatewayClient.ts";

/** Credentials stay in the owning server process and native ephemeral dispatcher. */
export async function configureMeerkatThreadBrowser(
  client: MeerkatGatewayClient,
  threadId: ThreadId,
  scope: Readonly<Record<string, unknown>>,
) {
  const session = readMcpProviderSession(threadId);
  if (!session?.capabilities.has("preview")) {
    await client.request("mobs.v1.browserConfigure", { ...scope, enabled: false });
    return;
  }
  await client.request("mobs.v1.browserConfigure", {
    ...scope,
    enabled: true,
    hostThreadId: threadId,
    hostSessionId: session.providerSessionId,
    endpoint: session.endpoint,
    authorizationHeader: session.authorizationHeader,
  });
}
