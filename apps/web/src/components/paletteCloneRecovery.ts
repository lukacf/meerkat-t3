import { ProjectCloneStartInput, type EnvironmentId, type ProjectId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { createStore } from "zustand/vanilla";
import { useLayoutEffect, useMemo, useRef } from "react";
import { safeOnboardingRemoteUrl } from "../onboarding/projectDraftStore";
import {
  browserAgentDraftStorage,
  writeAgentDraftStorage,
  type AgentDraftStorage,
} from "./team/agentDraftStorage";

const CloneInput = Schema.Struct({
  projectId: ProjectCloneStartInput.fields.projectId,
  title: ProjectCloneStartInput.fields.title,
  createdAt: ProjectCloneStartInput.fields.createdAt,
  destinationPath: ProjectCloneStartInput.fields.destinationPath,
  // A private URL is deliberately absent after reload. It is never a redacted retry URL.
  remoteUrl: Schema.String,
});
export type PaletteCloneInput = typeof CloneInput.Type;
const Attempt = Schema.Struct({
  input: CloneInput,
  admittedCwd: Schema.NullOr(ProjectCloneStartInput.fields.destinationPath),
});
type PaletteCloneAttempt = typeof Attempt.Type;
const decodeAttempt = Schema.decodeUnknownSync(Attempt);
const decodeCleared = Schema.decodeUnknownSync(
  Schema.Struct({ status: Schema.Literal("cleared") }),
);
const durable = (attempt: PaletteCloneAttempt): PaletteCloneAttempt => ({
  ...attempt,
  input: { ...attempt.input, remoteUrl: safeOnboardingRemoteUrl(attempt.input.remoteUrl) },
});

interface CloneOperations {
  build?: () => PaletteCloneInput;
  readProject: (projectId: ProjectId) => { workspaceRoot: string } | null;
  start: (input: PaletteCloneInput) => Promise<{ projectId: ProjectId; cwd: string }>;
  // The caller checks its current palette flow again after any asynchronous route preparation.
  open: (projectId: ProjectId, cwd: string, isCurrent: () => boolean) => Promise<boolean>;
  isCurrent: () => boolean;
}

/** A closing dialog stays mounted for its exit animation. Its old actions must already be inert. */
export function usePaletteCloneScope(open: boolean, scope: object): () => boolean {
  const active = useRef<object | null>(null);
  const token = useMemo(() => ({ open, scope }), [open, scope]);
  useLayoutEffect(() => {
    active.current = open ? token : null;
    return () => {
      active.current = null;
    };
  }, [open, token]);
  return useMemo(() => () => active.current === token, [token]);
}

/** Owns only a local admission attempt. The server's clone snapshot still owns clone progress. */
export function createPaletteCloneRecovery(
  environmentId: EnvironmentId | null,
  storage: AgentDraftStorage | undefined = browserAgentDraftStorage("localStorage"),
) {
  const key = environmentId === null ? null : `t3code:palette-clone:v1:${environmentId}`;
  let unreadableValue: string | null = null;
  const read = (): PaletteCloneAttempt | "cleared" | null => {
    unreadableValue = null;
    if (!key) return null;
    if (!storage) throw new Error("Local storage unavailable");
    const raw = storage.getItem(key);
    if (raw === null) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null && "status" in parsed) {
        decodeCleared(parsed);
        return "cleared";
      }
      return durable(decodeAttempt(parsed));
    } catch {
      unreadableValue = raw;
      throw new Error("Unreadable saved clone request");
    }
  };
  let initial: PaletteCloneAttempt | null = null;
  let initialError: string | null = null;
  const readError = () =>
    unreadableValue === null
      ? "Could not read clone recovery. Restore local storage access before cloning."
      : "The saved clone request is unreadable. Forget it to enter the repository again.";
  try {
    const saved = read();
    initial = saved === "cleared" ? null : saved;
  } catch {
    initialError = readError();
  }
  return createStore<{
    attempt: PaletteCloneAttempt | null;
    pending: boolean;
    error: string | null;
    canForgetUnreadable: boolean;
    forgetUnreadable: () => boolean;
    reconcile: (readProject: CloneOperations["readProject"]) => void;
    forget: (projectId: ProjectId) => boolean;
    run: (operations: CloneOperations) => Promise<void>;
  }>((set, get) => {
    const failedRead = () =>
      set({ error: readError(), canForgetUnreadable: unreadableValue !== null });
    const current = () => {
      const saved = read();
      const previous = get().attempt;
      if (saved === "cleared") return null;
      if (previous && saved === null) throw new Error("Pending clone recovery disappeared");
      // Preserve a private URL only in the view that submitted this exact input.
      if (
        saved &&
        previous &&
        JSON.stringify(durable(previous).input) === JSON.stringify(saved.input)
      ) {
        return { ...saved, input: previous.input };
      }
      return saved;
    };
    const write = (attempt: PaletteCloneAttempt) => {
      if (!key || !writeAgentDraftStorage(storage, key, durable(attempt))) {
        set({
          error:
            "Could not save clone recovery. Keep this page open and restore local storage access.",
        });
        return false;
      }
      set({ attempt, error: null, canForgetUnreadable: false });
      return true;
    };
    const accept = (projectId: ProjectId, cwd: string) => {
      const saved = current();
      if (saved?.input.projectId !== projectId) return false;
      if (saved.admittedCwd === cwd) {
        set({ attempt: saved, canForgetUnreadable: false });
        return true;
      }
      return write({ ...saved, admittedCwd: cwd });
    };
    const clear = (projectId: ProjectId) => {
      if (!key || current()?.input.projectId !== projectId) return false;
      if (!writeAgentDraftStorage(storage, key, { status: "cleared" })) {
        set({ error: "Could not clear clone recovery. Keep the saved project request and retry." });
        return false;
      }
      set({ attempt: null, error: null, canForgetUnreadable: false });
      return true;
    };
    return {
      attempt: initial,
      pending: false,
      error: initialError,
      canForgetUnreadable: unreadableValue !== null,
      forgetUnreadable: () => {
        const observed = unreadableValue;
        if (!key || !storage || observed === null || get().pending) return false;
        try {
          // Explicit discard is tied to the unreadable bytes shown in this view. A newer
          // request from another window must be recovered, never erased by this action.
          if (storage.getItem(key) !== observed) {
            const saved = read();
            set({
              attempt: saved === "cleared" ? null : saved,
              error: null,
              canForgetUnreadable: false,
            });
            return false;
          }
          if (!writeAgentDraftStorage(storage, key, { status: "cleared" })) {
            set({
              error: "Could not forget the saved request. Restore local storage access and retry.",
            });
            return false;
          }
          unreadableValue = null;
          set({ attempt: null, error: null, canForgetUnreadable: false });
          return true;
        } catch {
          failedRead();
          return false;
        }
      },
      reconcile: (readProject) => {
        try {
          const saved = current();
          set({ attempt: saved, canForgetUnreadable: false });
          if (!saved || get().pending) return;
          const project = readProject(saved.input.projectId);
          if (project) accept(saved.input.projectId, project.workspaceRoot);
        } catch {
          failedRead();
        }
      },
      forget: (projectId) => {
        if (get().pending) return false;
        try {
          const saved = read();
          if (saved === "cleared") {
            set({ attempt: null, error: null, canForgetUnreadable: false });
            return true;
          }
          if (saved === null && get().attempt?.input.projectId === projectId) {
            if (!key || !writeAgentDraftStorage(storage, key, { status: "cleared" })) {
              set({
                error:
                  "Could not forget the saved request. Restore local storage access and retry.",
              });
              return false;
            }
            set({ attempt: null, error: null, canForgetUnreadable: false });
            return true;
          }
          return saved?.input.projectId === projectId ? clear(projectId) : false;
        } catch {
          failedRead();
          return false;
        }
      },
      run: async (operations) => {
        if (!key || get().pending || !operations.isCurrent()) return;
        // Synchronous admission prevents double Enter before React renders the pending state.
        set({ pending: true, error: null });
        try {
          let saved = current();
          if (!saved) {
            if (!operations.build) return;
            saved = decodeAttempt({ input: operations.build(), admittedCwd: null });
            if (!write(saved)) return;
          } else {
            set({ attempt: saved, canForgetUnreadable: false });
          }
          const { input } = saved;
          let cwd = operations.readProject(input.projectId)?.workspaceRoot ?? saved.admittedCwd;
          if (!cwd) {
            if (!input.remoteUrl) {
              set({
                error:
                  "The private repository URL was not saved. Recover once the project appears, or forget this request to enter it again.",
              });
              return;
            }
            try {
              const result = await operations.start(input);
              if (result.projectId !== input.projectId || !result.cwd.trim()) {
                set({
                  error:
                    "The clone response could not be confirmed. Recover this request before starting another clone.",
                });
                return;
              }
              cwd = result.cwd;
            } catch {
              // start is not an idempotent retry RPC. An existing exact project proves admission;
              // a missing projection or any transport error does not prove rejection.
              cwd = operations.readProject(input.projectId)?.workspaceRoot ?? null;
              if (!cwd) {
                set({
                  error:
                    "Clone not confirmed. Recover this request without creating a duplicate, or forget it to change the input.",
                });
                return;
              }
            }
          }
          if (!accept(input.projectId, cwd) || !operations.isCurrent()) return;
          if (await operations.open(input.projectId, cwd, operations.isCurrent)) {
            clear(input.projectId);
          }
        } catch {
          if (unreadableValue !== null) failedRead();
          else
            set({
              error:
                "Could not open the saved clone request. Keep it and retry after the connection or local storage is available.",
            });
        } finally {
          set({ pending: false });
        }
      },
    };
  });
}
