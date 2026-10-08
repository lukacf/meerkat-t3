import {
  type ProjectTerminalAttachInput,
  ProjectTerminalError,
  type ProjectTerminalEvent,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { Atom } from "effect/unstable/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { subscribe, type EnvironmentRpcInput } from "../rpc/client.ts";
import {
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
  createEnvironmentSubscriptionAtomFamily,
} from "./runtime.ts";
import {
  appendOutput,
  resetOutput,
  EMPTY_TERMINAL_OUTPUT_STATE,
  DEFAULT_MAX_TERMINAL_BUFFER_BYTES,
  type TerminalOutputState,
} from "./terminalOutput.ts";
export { readTerminalOutputUpdate, INITIAL_TERMINAL_OUTPUT_CURSOR } from "./terminalOutput.ts";
export type ProjectTerminalState = {
  output: TerminalOutputState;
  status: string;
  label: string;
  cwd: string | null;
  error: string | null;
};
export const EMPTY_PROJECT_TERMINAL: ProjectTerminalState = {
  output: EMPTY_TERMINAL_OUTPUT_STATE,
  status: "connecting",
  label: "Project terminal",
  cwd: null,
  error: null,
};
export function applyProjectTerminalEvent(
  state: ProjectTerminalState,
  event: ProjectTerminalEvent,
): ProjectTerminalState {
  return {
    output:
      event.type === "snapshot" || event.type === "cleared"
        ? resetOutput(state.output, event.data ?? "", DEFAULT_MAX_TERMINAL_BUFFER_BYTES)
        : event.type === "output"
          ? appendOutput(state.output, event.data ?? "", DEFAULT_MAX_TERMINAL_BUFFER_BYTES)
          : state.output,
    status: event.status ?? (event.type === "closed" ? "closed" : state.status),
    label: event.label ?? state.label,
    cwd: event.cwd ?? state.cwd,
    error:
      event.type === "error"
        ? (event.message ?? "Terminal error")
        : event.type === "snapshot"
          ? null
          : state.error,
  };
}
export const awaitProjectTerminalReady = Effect.fn("ProjectTerminal.awaitReady")(function* <E, R>(
  input: ProjectTerminalAttachInput,
  events: Stream.Stream<ProjectTerminalEvent, E, R>,
) {
  const event = yield* events.pipe(Stream.runHead);
  if (Option.isNone(event) || event.value.type !== "snapshot" || event.value.status !== "running")
    return yield* new ProjectTerminalError({
      projectId: input.projectId,
      message: "The project terminal did not become available.",
    });
  return event.value;
});

export function createProjectTerminalAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    // Attach is the server-authorized project open operation. Releasing this one-shot
    // subscription leaves the shell running; command submission follows its snapshot.
    open: createEnvironmentCommand(runtime, {
      label: "projectTerminal:open",
      execute: (input: ProjectTerminalAttachInput) =>
        awaitProjectTerminalReady(input, subscribe(WS_METHODS.projectTerminalAttach, input)),
    }),
    attach: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "projectTerminal:attach",
      subscribe: (input: EnvironmentRpcInput<typeof WS_METHODS.projectTerminalAttach>) =>
        Stream.suspend(() =>
          subscribe(WS_METHODS.projectTerminalAttach, input).pipe(
            Stream.scan(EMPTY_PROJECT_TERMINAL, applyProjectTerminalEvent),
          ),
        ),
    }),
    write: createEnvironmentRpcCommand(runtime, {
      label: "projectTerminal:write",
      tag: WS_METHODS.projectTerminalWrite,
    }),
    resize: createEnvironmentRpcCommand(runtime, {
      label: "projectTerminal:resize",
      tag: WS_METHODS.projectTerminalResize,
    }),
    clear: createEnvironmentRpcCommand(runtime, {
      label: "projectTerminal:clear",
      tag: WS_METHODS.projectTerminalClear,
    }),
    close: createEnvironmentRpcCommand(runtime, {
      label: "projectTerminal:close",
      tag: WS_METHODS.projectTerminalClose,
    }),
  };
}
