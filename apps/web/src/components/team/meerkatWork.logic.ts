import type { MeerkatProjectTeam, MeerkatTeamAgent, ProviderInstanceId } from "@t3tools/contracts";

export function meerkatWorkStatus(agent: MeerkatTeamAgent, now: number) {
  if (agent.canResume) return "Stopped";
  if (agent.availability === "unloaded") return "Unloaded";
  if (agent.availability === "retired") return "History";
  if (agent.availability === "unknown") return "Unavailable";
  if (!agent.work || agent.work.status === "unknown") return "Status unknown";
  const observed = Date.parse(agent.work.observedAt);
  if (!Number.isFinite(observed) || now - observed > 30_000) return "Status stale";
  return agent.work.status === "running"
    ? "Working"
    : agent.work.status === "idle"
      ? "Idle"
      : "Unloaded";
}

export interface NativeCompletionNotice {
  key: string;
  instanceId: ProviderInstanceId;
  agent: MeerkatTeamAgent;
  status: "completed" | "failed";
}

/** First observation establishes a baseline, including agents discovered after reconnect. */
export class NativeCompletionTracker {
  private readonly known = new Map<string, number>();
  private readonly seen = new Set<string>();
  observe(team: MeerkatProjectTeam): NativeCompletionNotice[] {
    const notices: NativeCompletionNotice[] = [];
    for (const provider of team.providers) {
      for (const agent of provider.agents) {
        const identity = `${provider.instanceId}:${agent.durableId ?? agent.agentRef}`;
        if (
          agent.availability !== "live" ||
          !agent.work ||
          !["idle", "running"].includes(agent.work.status)
        )
          continue;
        const baseline = !this.known.has(identity);
        if (baseline) this.known.set(identity, Date.parse(agent.work.observedAt));
        const terminal = agent.work?.latestCompletion;
        if (
          !terminal ||
          agent.availability !== "live" ||
          ("kind" in terminal && terminal.sessionId !== agent.record.session_id)
        )
          continue;
        const key = JSON.stringify([
          provider.instanceId,
          agent.mobId,
          agent.record.runtime_key,
          agent.record.identity,
          agent.record.session_id,
          ...("kind" in terminal
            ? ["runtime_input", terminal.inputId, terminal.runId]
            : [terminal.interactionId]),
        ]);
        if (this.seen.has(key)) continue;
        this.seen.add(key);
        if (!baseline && terminal.timestampMs >= (this.known.get(identity) ?? Infinity))
          notices.push({ key, instanceId: provider.instanceId, agent, status: terminal.status });
      }
    }
    return notices;
  }
}
