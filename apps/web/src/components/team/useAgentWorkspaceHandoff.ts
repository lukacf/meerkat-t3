import { CommandId, type ModelSelection } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import {
  composerDraftHasUserContent,
  flushComposerDraftPersistence,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { environmentCatalog } from "../../connection/catalog";
import { readThreadShell, useThreadShell } from "../../state/entities";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../../state/server";
import { getAgentModelSendBlock } from "./agentModelReadiness";
import { formatEnvironmentQueryError } from "../../state/query";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { newThreadId } from "../../lib/utils";
import {
  agentWorkspaceOriginPath,
  useAgentWorkspaceHandoffStore,
  type AgentWorkspaceHandoff,
} from "./agentWorkspaceHandoffStore";
import {
  agentWorkspaceHandoffAttemptKey,
  createAgentWorkspaceHandoffAttemptStore,
  type AgentWorkspaceHandoffAttempt,
  type AgentWorkspaceHandoffScope,
} from "./agentWorkspaceHandoffAttemptStore";

type Input = Omit<AgentWorkspaceHandoff, "hostThreadId"> & {
  modelSelection: ModelSelection;
  worktreePath: string | null;
  summary?: string;
};

export function useAgentWorkspaceHandoff(scope: AgentWorkspaceHandoffScope | null) {
  const navigate = useNavigate();
  const create = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const retryConnection = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false });
  const key = scope ? agentWorkspaceHandoffAttemptKey(scope) : null;
  const store = useMemo(() => createAgentWorkspaceHandoffAttemptStore(key), [key]);
  const saved = useStore(store);
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const [destination, setDestination] = useState<{ key: string; threadId: string } | null>(null);
  const [delayedKey, setDelayedKey] = useState<string | null>(null);
  const current = useRef<typeof store | null>(null);
  const inFlight = useRef(new Set<string>());
  const navigating = useRef<typeof destination>(null);
  useLayoutEffect(() => {
    current.current = store;
    return () => {
      current.current = null;
    };
  }, [store]);
  const attempt = saved.attempt;
  const shell = useThreadShell(
    attempt
      ? scopeThreadRef(attempt.record.origin.environmentId, attempt.record.hostThreadId)
      : null,
  );
  const opening =
    key !== null &&
    destination?.key === key &&
    destination.threadId === attempt?.record.hostThreadId;
  const pending = key !== null && pendingKeys.has(key);
  useEffect(() => {
    if (
      !opening ||
      !destination ||
      !attempt ||
      !shell ||
      shell.id !== attempt.record.hostThreadId ||
      shell.projectId !== attempt.record.origin.projectId ||
      navigating.current === destination
    )
      return;
    navigating.current = destination;
    void navigate({
      to: "/$environmentId/$threadId",
      params: {
        environmentId: attempt.record.origin.environmentId,
        threadId: attempt.record.hostThreadId,
      },
    })
      .then(() => {
        // Only a confirmed task that was actually opened releases the original attempt.
        // An uncertain reply, failed draft save, or failed navigation still retries that ID.
        store.getState().complete(attempt.record.hostThreadId);
      })
      .catch((cause: unknown) => {
        if (current.current === store && key)
          setError({
            key,
            message:
              cause instanceof Error
                ? cause.message
                : "Could not open the saved task. Retry opening it.",
          });
      })
      .finally(() => {
        // Store publications during cleanup must not open the same task repeatedly.
        // A failed cleanup stays available through an explicit recovery click.
        if (current.current === store)
          setDestination((value) => (value === destination ? null : value));
      });
  }, [attempt, destination, key, navigate, opening, shell, store]);
  useEffect(() => {
    if (!key || !opening || shell) return;
    const timeout = setTimeout(() => setDelayedKey(key), 10_000);
    return () => clearTimeout(timeout);
  }, [key, opening, shell]);

  function prepare(input: Input): AgentWorkspaceHandoffAttempt {
    const config = appAtomRegistry
      .get(environmentServerConfigsAtom)
      .get(input.origin.environmentId);
    if (!config) throw new Error("Reconnect this environment before opening a task.");
    const block = getAgentModelSendBlock({
      instanceId: input.modelSelection.instanceId,
      selection: input.modelSelection,
      currentModel: undefined,
      steering: false,
      cwd: input.cwd,
      serverConfig: config,
    });
    if (block) throw new Error(block.reason);
    const threadId = newThreadId();
    return {
      record: {
        purpose: input.purpose,
        origin: input.origin,
        target: input.target,
        hostThreadId: threadId,
        cwd: input.cwd,
        branch: input.branch,
      },
      command: {
        type: "thread.create",
        threadId,
        commandId: CommandId.make(`native-workspace-handoff:${threadId}`),
        projectId: input.origin.projectId,
        title: `${input.purpose === "browser" ? "Browser for" : "Delivery from"} ${input.origin.label}`,
        modelSelection: input.modelSelection,
        runtimeMode: resolveProjectSettings(config.settings, input.origin.projectId).settings
          .defaultRuntimeMode,
        interactionMode: "default",
        branch: input.branch,
        worktreePath: input.worktreePath,
        createdAt: new Date().toISOString(),
      },
      prompt: [
        input.purpose === "browser"
          ? `Prepare this conversation as a browser workspace for ${input.origin.label}. Wait for my next instructions before changing files or running commands.`
          : `Continue delivery of the current changes from ${input.origin.label}. Inspect the working tree and help me review, test, commit and open a pull request when I ask.`,
        `Workspace: ${input.cwd}${input.branch ? `\nBranch at handoff: ${input.branch}` : ""}`,
        `Source conversation: ${agentWorkspaceOriginPath(input.origin)}`,
        ...(input.summary ? [`Latest task context:\n${input.summary}`] : []),
        "The source conversation's history is not copied into this task. I will add the relevant findings or instructions below.",
      ].join("\n\n"),
      accepted: false,
      contextSaved: false,
    };
  }

  function finish(savedAttempt: AgentWorkspaceHandoffAttempt) {
    const { record } = savedAttempt;
    if (!store.getState().accept(record.hostThreadId)) return false;
    if (!savedAttempt.contextSaved) {
      const ref = scopeThreadRef(record.origin.environmentId, record.hostThreadId);
      const existing = readThreadShell(ref);
      const draft = useComposerDraftStore.getState().getComposerDraft(ref);
      // A recovered receipt must not replace typing or repopulate an already used task.
      if (!existing?.latestTurn && !composerDraftHasUserContent(draft))
        useComposerDraftStore.getState().setPrompt(ref, savedAttempt.prompt);
      if (!flushComposerDraftPersistence()) {
        if (current.current === store && key)
          setError({
            key,
            message:
              "The task is saved, but its context draft could not be saved locally. Retry opening the saved task; no second task will be created.",
          });
        return false;
      }
    }
    // Load the durable context into this view as well, including recovery in another window.
    // Keep the original handoff available even when existing typing cannot be replaced.
    if (!useAgentWorkspaceHandoffStore.getState().saveContext(record, savedAttempt.prompt)) {
      if (current.current === store && key)
        setError({
          key,
          message:
            "The task is saved, but its handoff context could not be saved locally. Retry opening the saved task.",
        });
      return false;
    }
    if (!savedAttempt.contextSaved && !store.getState().markContextSaved(record.hostThreadId))
      return false;
    return true;
  }

  async function run(input?: Input) {
    if (!key || current.current !== store || inFlight.current.has(key)) return;
    if (input && agentWorkspaceHandoffAttemptKey(input) !== key) return;
    inFlight.current.add(key);
    setPendingKeys((keys) => new Set([...keys, key]));
    setError(null);
    try {
      // Read the durable attempt before inspecting new inputs or allocating an identity.
      const prepared = store.getState().prepare(() => {
        if (!input)
          throw new Error(
            "No saved workspace request was found. Start a new handoff from the agent.",
          );
        return prepare(input);
      });
      if (!prepared) return;
      const { record, command } = prepared;
      const existing = readThreadShell(
        scopeThreadRef(record.origin.environmentId, record.hostThreadId),
      );
      if (
        existing &&
        (existing.id !== record.hostThreadId || existing.projectId !== record.origin.projectId)
      )
        throw new Error(
          "The saved task no longer belongs to this project. No new task was created.",
        );
      if (!prepared.accepted && !existing) {
        const { type: _type, ...createInput } = command;
        const result = await create({
          environmentId: record.origin.environmentId,
          input: createInput,
        });
        if (result._tag !== "Success") {
          if (current.current === store)
            setError({
              key,
              message: `${formatEnvironmentQueryError(result.cause)}. Retry opening this task to check its outcome without creating a duplicate.`,
            });
          return;
        }
      }
      if (!finish(prepared) || current.current !== store) return;
      setDestination({ key, threadId: record.hostThreadId });
      // A recovered accepted receipt needs projection recovery, never another create.
      if (prepared.accepted && !existing) {
        const result = await retryConnection(record.origin.environmentId);
        if (result._tag !== "Success" && current.current === store)
          setError({ key, message: formatEnvironmentQueryError(result.cause) });
      }
    } catch (cause) {
      if (current.current === store)
        setError({
          key,
          message:
            cause instanceof Error
              ? cause.message
              : "Could not open the workspace. Retry the saved request.",
        });
    } finally {
      inFlight.current.delete(key);
      if (current.current !== null)
        setPendingKeys((keys) => {
          const next = new Set(keys);
          next.delete(key);
          return next;
        });
    }
  }
  const recovery =
    attempt && !pending && (!opening || delayedKey === key || saved.error || error?.key === key)
      ? {
          retry: () => run(),
          pending,
          label: attempt.accepted || shell ? "Open saved task" : "Retry opening task",
          message:
            attempt.accepted || shell
              ? "Your task is saved. Open it to continue."
              : "This task has not been confirmed yet. Retry to recover it without creating a duplicate.",
        }
      : null;
  return {
    start: (input: Input) => run(input),
    resume: () => run(),
    savedAttempt: attempt,
    pending: pending || opening,
    error: saved.error ?? (error?.key === key ? error.message : null),
    recovery,
  };
}
