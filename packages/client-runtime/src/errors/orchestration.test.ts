import { OrchestrationDispatchCommandError } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  wasBootstrapThreadDeleted,
  wasBootstrapThreadNotCreated,
  wasBootstrapThreadRetained,
} from "./orchestration.ts";

describe("wasBootstrapThreadDeleted", () => {
  it("keeps retained requests separate from deleted, absent, and ambiguous failures", () => {
    const retained = new OrchestrationDispatchCommandError({
      message: "Account required",
      bootstrapThreadDisposition: "retained",
    });
    expect(wasBootstrapThreadRetained(retained)).toBe(true);
    expect(wasBootstrapThreadDeleted(retained)).toBe(false);
    expect(wasBootstrapThreadNotCreated(retained)).toBe(false);
    expect(wasBootstrapThreadRetained(new Error("retained"))).toBe(false);
    expect(
      wasBootstrapThreadRetained(
        new OrchestrationDispatchCommandError({
          message: "failed",
          bootstrapThreadDisposition: "deleted",
        }),
      ),
    ).toBe(false);
  });
  it("accepts only a confirmed deleted bootstrap thread", () => {
    expect(
      wasBootstrapThreadDeleted(
        new OrchestrationDispatchCommandError({
          message: "Failed to create worktree.",
          bootstrapThreadDisposition: "deleted",
        }),
      ),
    ).toBe(true);
    expect(
      wasBootstrapThreadDeleted(
        new OrchestrationDispatchCommandError({ message: "Failed to create worktree." }),
      ),
    ).toBe(false);
    expect(wasBootstrapThreadDeleted(new Error("connection lost"))).toBe(false);
  });
});

describe("wasBootstrapThreadNotCreated", () => {
  it("accepts only a confirmed never-created bootstrap thread", () => {
    const notCreated = new OrchestrationDispatchCommandError({
      message: "A separate worktree requires a base commit.",
      bootstrapThreadDisposition: "not-created",
    });
    expect(wasBootstrapThreadNotCreated(notCreated)).toBe(true);
    expect(wasBootstrapThreadDeleted(notCreated)).toBe(false);
    expect(
      wasBootstrapThreadNotCreated(
        new OrchestrationDispatchCommandError({
          message: "Failed to create worktree.",
          bootstrapThreadDisposition: "deleted",
        }),
      ),
    ).toBe(false);
    expect(
      wasBootstrapThreadNotCreated(
        new OrchestrationDispatchCommandError({
          message: "Failed to create worktree.",
        }),
      ),
    ).toBe(false);
    expect(wasBootstrapThreadNotCreated(new Error("connection lost"))).toBe(false);
  });
});
