import type { EnvironmentAgentSearchMatch } from "../../state/meerkatSearch";

export function nativeSearchDestination(match: EnvironmentAgentSearchMatch) {
  const search =
    match.message && match.agentRef
      ? {
          nativeAgent: match.agentRef,
          nativeInstance: match.instanceId,
          nativeSession: match.message.sessionId,
          nativeRevision: match.message.storeRevision,
          nativeOffset: match.message.offset,
        }
      : {};
  if (match.threadId && match.agentRef)
    return {
      to: "/$environmentId/$threadId" as const,
      params: { environmentId: match.environmentId, threadId: match.threadId },
      search: { ...search, member: match.agentRef },
    };
  if (match.projectAgentId)
    return {
      to: "/$environmentId/agents/$agentId" as const,
      params: { environmentId: match.environmentId, agentId: match.projectAgentId },
      search: { ...search, project: match.projectId },
    };
  return null;
}

export function validateNativeSearchLocation(search: Record<string, unknown>) {
  const nonempty = (key: string) =>
    typeof search[key] === "string" && search[key].length > 0 ? search[key] : undefined;
  const nativeAgent = nonempty("nativeAgent");
  const nativeInstance = nonempty("nativeInstance");
  const nativeSession = nonempty("nativeSession");
  const nativeRevision = nonempty("nativeRevision");
  const rawOffset =
    typeof search.nativeOffset === "string" && /^\d+$/.test(search.nativeOffset)
      ? Number(search.nativeOffset)
      : search.nativeOffset;
  const nativeOffset =
    typeof rawOffset === "number" && Number.isSafeInteger(rawOffset) && rawOffset >= 0
      ? rawOffset
      : undefined;
  return {
    ...(nativeAgent ? { nativeAgent } : {}),
    ...(nativeAgent && nativeInstance ? { nativeInstance } : {}),
    ...(nativeAgent && nativeSession && nativeRevision && nativeOffset !== undefined
      ? { nativeSession, nativeRevision, nativeOffset }
      : {}),
  };
}
