import {
  PreparedThreadTurnCommand,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type ThreadPreparedTurn,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const sameCommand = Schema.toEquivalence(PreparedThreadTurnCommand);
const sameMessage = Schema.toEquivalence(PreparedThreadTurnCommand.fields.message);

export function preparedTurnBindingBlock(
  model: OrchestrationReadModel,
  prepared: ThreadPreparedTurn,
): string | null {
  const thread = model.threads.find(
    (entry) =>
      entry.id === prepared.command.threadId &&
      entry.deletedAt === null &&
      entry.archivedAt === null,
  );
  const project = model.projects.find(
    (entry) => entry.id === prepared.projectId && entry.deletedAt === null,
  );
  if (
    !thread ||
    !project ||
    thread.projectId !== prepared.projectId ||
    project.workspaceRoot !== prepared.projectCwd ||
    prepared.expectedCwd === null ||
    thread.worktreePath !== prepared.expectedCwd
  ) {
    return "The saved checkout has changed or is unavailable. Open the original thread to review its prepared message.";
  }
  if (thread.latestTurn !== null || thread.session?.activeTurnId != null)
    return "This thread has already started work. Check its history before retrying the saved message.";
  const message = thread.messages.find((entry) => entry.id === prepared.command.message.messageId);
  if (
    !message ||
    message.role !== "user" ||
    message.turnId !== null ||
    !sameMessage(
      {
        messageId: message.id,
        role: "user",
        text: message.text,
        attachments: message.attachments ?? [],
        ...(message.context !== undefined ? { context: message.context } : {}),
      },
      prepared.command.message,
    )
  )
    return "The original saved message has changed. Edit the prepared message before sending it.";
  if (
    thread.runtimeMode !== prepared.command.runtimeMode ||
    thread.interactionMode !== prepared.command.interactionMode
  )
    return "The thread's modes changed. Edit the prepared message before sending it.";
  return null;
}

export function preparedTurnStartBlock(
  model: OrchestrationReadModel,
  command: OrchestrationCommand,
  authorization?: {
    readonly preparedTurnRecoveryId?: string;
    readonly continueAfterInterruptedSetup?: boolean;
  },
): string | null {
  if (command.type !== "thread.turn.start") return null;
  const prepared = model.threads.find((entry) => entry.id === command.threadId)?.preparedTurn;
  if (!prepared || prepared.phase === "released") {
    return authorization?.preparedTurnRecoveryId
      ? "The saved prepared turn is no longer pending."
      : null;
  }
  if (
    authorization?.preparedTurnRecoveryId !== prepared.recoveryId ||
    command.commandId !== prepared.recoveryId ||
    command.bootstrap !== undefined ||
    !sameCommand(prepared.command, command)
  ) {
    return "This thread has a prepared message. Retry or edit that message before starting another turn.";
  }
  if (prepared.phase === "preparing")
    return "Checkout preparation has not completed. Review the interrupted setup before sending this message.";
  const bindingBlock = preparedTurnBindingBlock(model, prepared);
  if (bindingBlock) return bindingBlock;
  if (
    (prepared.setup === "not_started" || prepared.setup === "sync_running") &&
    !authorization?.continueAfterInterruptedSetup
  ) {
    return "Setup did not finish. Confirm that you want to continue without rerunning setup.";
  }
  return null;
}
