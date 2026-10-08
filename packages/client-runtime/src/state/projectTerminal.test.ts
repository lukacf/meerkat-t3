import { describe, expect, it } from "@effect/vitest";
import { ProjectId, type ProjectTerminalEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import {
  applyProjectTerminalEvent,
  awaitProjectTerminalReady,
  EMPTY_PROJECT_TERMINAL,
  INITIAL_TERMINAL_OUTPUT_CURSOR,
  readTerminalOutputUpdate,
} from "./projectTerminal.ts";
import { DEFAULT_MAX_TERMINAL_BUFFER_BYTES } from "./terminalOutput.ts";

const target = { projectId: ProjectId.make("project-a"), terminalId: "shell-a" };
describe("project terminal output", () => {
  it("replaces history on reconnect, appends new output once, and clears the rendered terminal", () => {
    let state = applyProjectTerminalEvent(EMPTY_PROJECT_TERMINAL, {
      ...target,
      type: "snapshot",
      data: "prior\r\n",
      status: "running",
      label: "zsh",
      cwd: "/workspace/project-a",
    });
    expect(state.cwd).toBe("/workspace/project-a");
    const initial = readTerminalOutputUpdate(state.output, INITIAL_TERMINAL_OUTPUT_CURSOR);
    expect(initial).toMatchObject({ type: "reset", data: "prior\r\n" });
    state = applyProjectTerminalEvent(state, { ...target, type: "output", data: "new\r\n" });
    const next = readTerminalOutputUpdate(state.output, initial.cursor);
    expect(next).toMatchObject({ type: "append", data: "new\r\n" });
    expect(readTerminalOutputUpdate(state.output, next.cursor).type).toBe("none");
    state = applyProjectTerminalEvent(state, {
      ...target,
      type: "snapshot",
      data: "prior\r\nnew\r\n",
      status: "running",
    });
    const reattached = readTerminalOutputUpdate(state.output, next.cursor);
    expect(reattached).toMatchObject({ type: "reset", data: "prior\r\nnew\r\n" });
    state = applyProjectTerminalEvent(state, { ...target, type: "cleared" });
    expect(readTerminalOutputUpdate(state.output, reattached.cursor)).toMatchObject({
      type: "reset",
      data: "",
    });
  });

  it("bounds retained UTF-8 output and preserves terminal failure until a fresh snapshot", () => {
    let state = applyProjectTerminalEvent(EMPTY_PROJECT_TERMINAL, {
      ...target,
      type: "output",
      data: "unicode: ".repeat(DEFAULT_MAX_TERMINAL_BUFFER_BYTES),
    });
    expect(state.output.retainedBytes).toBeLessThanOrEqual(DEFAULT_MAX_TERMINAL_BUFFER_BYTES);
    state = applyProjectTerminalEvent(state, {
      ...target,
      type: "error",
      status: "error",
      message: "Shell ended unexpectedly",
    });
    state = applyProjectTerminalEvent(state, { ...target, type: "activity", label: "zsh" });
    expect(state.error).toBe("Shell ended unexpectedly");
    expect(state.status).toBe("error");
    state = applyProjectTerminalEvent(state, { ...target, type: "snapshot", status: "running" });
    expect(state.error).toBeNull();
    expect(state.status).toBe("running");
  });
});

describe("project action terminal readiness", () => {
  it.effect(
    "releases its reader after the authoritative running snapshot before submitting a command",
    () =>
      Effect.gen(function* () {
        const timeline: string[] = [];
        const snapshot: ProjectTerminalEvent = {
          ...target,
          type: "snapshot",
          status: "running",
          cwd: "/project",
          data: "history",
        };
        const events = Stream.concat(Stream.make(snapshot), Stream.never).pipe(
          Stream.ensuring(
            Effect.sync(() => {
              timeline.push("detach reader");
            }),
          ),
        );
        const opened = yield* awaitProjectTerminalReady(target, events);
        timeline.push("write action");
        expect(opened).toEqual(snapshot);
        expect(timeline).toEqual(["detach reader", "write action"]);
      }),
  );

  it.effect(
    "rejects a failed or exited shell and a missing snapshot before the action can be submitted",
    () =>
      Effect.gen(function* () {
        const samples: Stream.Stream<ProjectTerminalEvent>[] = [
          Stream.empty,
          Stream.make({ ...target, type: "error", status: "error", message: "cannot spawn" }),
          Stream.make({ ...target, type: "snapshot", status: "exited", data: "old history" }),
        ];
        for (const events of samples) {
          const error = yield* awaitProjectTerminalReady(target, events).pipe(Effect.flip);
          expect(error).toMatchObject({
            _tag: "ProjectTerminalError",
            projectId: target.projectId,
            message: "The project terminal did not become available.",
          });
        }
      }),
  );
});
