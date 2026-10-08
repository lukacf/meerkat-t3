import {
  MeerkatAgentQueuePayload,
  type EnvironmentId,
  type MeerkatAgentQueue,
  type MeerkatAgentQueueTarget,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { UnsentAgentMessage } from "./agentUnsentQueueStore";

const encodePayload = Schema.encodeSync(Schema.fromJsonString(MeerkatAgentQueuePayload));

export function agentQueueImportPayload(row: UnsentAgentMessage) {
  return {
    text: row.text,
    ...(row.images ? { images: row.images } : {}),
    ...(row.modelSelection ? { modelSelection: row.modelSelection } : {}),
    ...(row.context ? { context: row.context } : {}),
  };
}

/** A matching recorded enqueue permits local cleanup, never a second dispatch. */
export function confirmedAgentQueueImport(
  row: UnsentAgentMessage,
  expected: {
    environmentId: EnvironmentId;
    target: MeerkatAgentQueueTarget;
    durableId: string | undefined;
  },
  observation: {
    environmentId: EnvironmentId;
    target: MeerkatAgentQueueTarget;
    queue: MeerkatAgentQueue | undefined;
    isPending: boolean;
    hasError: boolean;
  },
) {
  const queue = observation.queue;
  if (
    !queue ||
    observation.isPending ||
    observation.hasError ||
    !expected.durableId ||
    queue.durableId !== expected.durableId ||
    observation.environmentId !== expected.environmentId ||
    observation.target.projectId !== expected.target.projectId ||
    observation.target.instanceId !== expected.target.instanceId ||
    observation.target.agentRef !== expected.target.agentRef
  )
    return undefined;
  const item = queue.items.find((item) => item.requestId === `import-${row.id}`);
  if (!item) return undefined;
  try {
    return encodePayload(item.payload) === encodePayload(agentQueueImportPayload(row))
      ? item
      : undefined;
  } catch {
    return undefined;
  }
}

/** A prior native send attempt cannot be reinterpreted as a new server-owned draft. */
export function nextAgentQueueImport(
  rows: ReadonlyArray<UnsentAgentMessage>,
  attempts: ReadonlyArray<{ queueId?: string }>,
) {
  const attempted = new Set(
    attempts.flatMap((attempt) => (attempt.queueId ? [attempt.queueId] : [])),
  );
  return rows.find((row) => !attempted.has(row.id));
}
