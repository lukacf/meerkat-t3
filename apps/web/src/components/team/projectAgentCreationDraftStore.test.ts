import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  createProjectAgentCreationDraftStore,
  projectAgentCreationScopeKey,
} from "./projectAgentCreationDraftStore";

function memoryStorage() {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    key: (index: number) => [...entries.keys()][index] ?? null,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
  };
}
const scope = {
  environmentId: EnvironmentId.make("environment-a"),
  projectId: ProjectId.make("project-a"),
  cwd: "/project-a",
};
const input = {
  projectId: scope.projectId,
  instanceId: ProviderInstanceId.make("native-a"),
  label: "Security reviewer",
  role: "security-reviewer",
  instructions: "Review authorization boundaries.",
  model: "openai:review-model",
  accessMode: "read-only" as const,
};
const receipt = {
  agentId: "created-original",
  projectId: scope.projectId,
  instanceId: input.instanceId,
};
const draft = {
  custom: true,
  label: input.label,
  role: input.role,
  instructions: input.instructions,
  instanceId: input.instanceId,
  chosenModel: input.model,
  accessMode: input.accessMode,
};

describe("project agent creation recovery", () => {
  it("snapshots reasoning through interrupted creation and retries despite changed caller selections", () => {
    const storage = memoryStorage();
    const options = [{ id: "reasoning_effort", value: "high" }];
    const first = createProjectAgentCreationDraftStore(scope, storage, () => "original");
    first.getState().updateDraft({ ...draft, options });
    const sent = first.getState().beginCustom({ ...input, options })!;
    options[0]!.value = "low";
    expect(first.getState().attempts[0]!.input.options).toEqual([
      { id: "reasoning_effort", value: "high" },
    ]);
    expect(first.getState().draft.value.options).toEqual([
      { id: "reasoning_effort", value: "high" },
    ]);
    const reopened = createProjectAgentCreationDraftStore(scope, storage);
    expect(reopened.getState().retry("original")?.input).toEqual(sent.input);
    reopened.getState().finish("original", "Response lost");
    expect(reopened.getState().beginCustom({ ...input, options })?.input).toEqual(sent.input);
    expect(reopened.getState().updateDraft({ options: [] })).toBe(false);
  });

  it("reads old drafts and pending requests without adding an options field", () => {
    const storage = memoryStorage();
    const first = createProjectAgentCreationDraftStore(scope, storage, () => "legacy");
    first.getState().updateDraft(draft);
    const original = first.getState().beginCustom(input)!;
    const prefix = projectAgentCreationScopeKey(scope);
    const raw = storage.getItem(`${prefix}request:legacy`);
    const reopened = createProjectAgentCreationDraftStore(scope, storage);
    expect(reopened.getState().draft.value.options).toBeUndefined();
    expect(reopened.getState().retry("legacy")).toEqual(original);
    expect(storage.getItem(`${prefix}request:legacy`)).toBe(raw);
    expect(reopened.getState().attempts[0]!.input).not.toHaveProperty("options");
  });

  it("persists an explicit model default separately from inherited reasoning", () => {
    const storage = memoryStorage();
    const first = createProjectAgentCreationDraftStore(scope, storage, () => "default");
    first.getState().updateDraft({ ...draft, options: [] });
    expect(
      createProjectAgentCreationDraftStore(scope, storage).getState().draft.value.options,
    ).toEqual([]);
    first.getState().beginCustom({ ...input, options: [] });
    expect(
      createProjectAgentCreationDraftStore(scope, storage).getState().retry("default")?.input
        .options,
    ).toEqual([]);
  });

  it("rejects a stale form when another window changes only its reasoning", () => {
    const storage = memoryStorage();
    const first = createProjectAgentCreationDraftStore(scope, storage, () => "original");
    first
      .getState()
      .updateDraft({ ...draft, options: [{ id: "reasoning_effort", value: "high" }] });
    const second = createProjectAgentCreationDraftStore(scope, storage);
    second.getState().updateDraft({ options: [{ id: "reasoning_effort", value: "low" }] });
    expect(
      first
        .getState()
        .beginCustom({ ...input, options: [{ id: "reasoning_effort", value: "high" }] }),
    ).toBeNull();
    expect(first.getState().draft.value.options).toEqual([
      { id: "reasoning_effort", value: "low" },
    ]);
    expect(first.getState().attempts).toEqual([]);
  });

  it("restores form edits only in their exact environment, project and checkout", () => {
    const storage = memoryStorage();
    const first = createProjectAgentCreationDraftStore(scope, storage, () => "original");
    first.getState().updateDraft(draft);
    expect(createProjectAgentCreationDraftStore(scope, storage).getState().draft).toEqual({
      intentId: "original",
      value: draft,
    });
    for (const other of [
      { ...scope, environmentId: EnvironmentId.make("environment-b") },
      { ...scope, projectId: ProjectId.make("project-b") },
      { ...scope, cwd: "/project-a/worktree" },
    ])
      expect(
        createProjectAgentCreationDraftStore(other, storage).getState().draft.value.label,
      ).toBe("");
  });

  it("retries an interrupted creation with its original immutable request after cold restart", () => {
    const storage = memoryStorage();
    const first = createProjectAgentCreationDraftStore(scope, storage, () => "original");
    first.getState().updateDraft(draft);
    const sent = first.getState().beginCustom(input)!;
    const allocate = vi.fn(() => "duplicate");
    const reopened = createProjectAgentCreationDraftStore(scope, storage, allocate);
    expect(reopened.getState().pendingIds).toEqual([]);
    expect(reopened.getState().updateDraft({ instructions: "Different" })).toBe(false);
    expect(reopened.getState().retry(sent.input.requestId)).toEqual(sent);
    expect(allocate).not.toHaveBeenCalled();
    expect(reopened.getState().retry(sent.input.requestId)).toBeNull();
    reopened.getState().finish("original", "Response lost");
    expect(reopened.getState().beginCustom({ ...input, model: "changed-model" })?.input).toEqual(
      sent.input,
    );
    expect(allocate).not.toHaveBeenCalled();
  });

  it("keeps an accepted result and original form after navigation, with no new request allocation", () => {
    const storage = memoryStorage();
    const first = createProjectAgentCreationDraftStore(scope, storage, () => "original");
    first.getState().updateDraft(draft);
    first.getState().beginCustom(input);
    expect(first.getState().accept("original", receipt)).toBe(true);
    first.getState().finish("original");
    const allocate = vi.fn();
    const reopened = createProjectAgentCreationDraftStore(scope, storage, allocate);
    expect(reopened.getState().retry("original")?.accepted).toEqual(receipt);
    expect(reopened.getState().draft.value).toEqual(draft);
    expect(allocate).not.toHaveBeenCalled();
  });

  it("preserves uncertain evidence across explicit edit-as-new and discard actions", () => {
    const storage = memoryStorage();
    const allocate = vi
      .fn()
      .mockReturnValueOnce("original")
      .mockReturnValueOnce("changed")
      .mockReturnValueOnce("empty");
    const store = createProjectAgentCreationDraftStore(scope, storage, allocate);
    store.getState().updateDraft(draft);
    store.getState().beginCustom(input);
    store
      .getState()
      .finish("original", "The server rejected a model check; acceptance is unconfirmed.");
    expect(store.getState().newDraft(true)).toBe(true);
    store.getState().updateDraft({ instructions: "Corrected responsibilities" });
    expect(
      store.getState().beginCustom({ ...input, instructions: "Corrected responsibilities" })?.input
        .requestId,
    ).toBe("changed");
    store.getState().finish("changed");
    store.getState().newDraft(false);
    const reopened = createProjectAgentCreationDraftStore(scope, storage);
    expect(reopened.getState().draft.value.label).toBe("");
    expect(reopened.getState().attempts.map((entry) => entry.input.requestId)).toEqual([
      "original",
      "changed",
    ]);
    expect(reopened.getState().retry("original")?.input).toEqual({
      ...input,
      requestId: "original",
    });
  });

  it("recovers a preset even if the roster is stale and the current model or provider changed", () => {
    const storage = memoryStorage();
    const first = createProjectAgentCreationDraftStore(scope, storage, () => "preset-original");
    first.getState().beginPreset(input);
    const allocate = vi.fn(() => "duplicate");
    const reopened = createProjectAgentCreationDraftStore(scope, storage, allocate);
    expect(
      reopened
        .getState()
        .beginPreset({ ...input, instanceId: ProviderInstanceId.make("other"), model: "other" })
        ?.input,
    ).toEqual({ ...input, requestId: "preset-original" });
    expect(allocate).not.toHaveBeenCalled();
  });

  it("recovers a matching custom request from the preset entry point instead of creating again", () => {
    const storage = memoryStorage();
    const first = createProjectAgentCreationDraftStore(scope, storage, () => "custom-original");
    first.getState().updateDraft(draft);
    first.getState().beginCustom(input);
    const allocate = vi.fn(() => "duplicate");
    const reopened = createProjectAgentCreationDraftStore(scope, storage, allocate);
    expect(
      reopened.getState().beginPreset({ ...input, instructions: "Preset default instructions" })
        ?.input.requestId,
    ).toBe("custom-original");
    expect(allocate).not.toHaveBeenCalled();
  });

  it("keeps distinct requests when another stale view completes or edits its own form", () => {
    const storage = memoryStorage();
    const first = createProjectAgentCreationDraftStore(scope, storage, () => "original");
    const second = createProjectAgentCreationDraftStore(scope, storage, () => "other-preset");
    first.getState().updateDraft(draft);
    first.getState().beginCustom(input);
    second.getState().beginPreset({ ...input, role: "builder", label: "Builder" });
    first.getState().accept("original", receipt);
    second.getState().finish("other-preset", "Network interrupted");
    const rows = createProjectAgentCreationDraftStore(scope, storage).getState().attempts;
    expect(rows).toHaveLength(2);
    expect(rows.find((entry) => entry.input.requestId === "original")?.accepted).toEqual(receipt);
  });

  it("does not downgrade an acceptance when an older retry fails later", () => {
    const storage = memoryStorage();
    const first = createProjectAgentCreationDraftStore(scope, storage, () => "original");
    first.getState().beginPreset(input);
    const second = createProjectAgentCreationDraftStore(scope, storage);
    second.getState().retry("original");
    first.getState().accept("original", receipt);
    second.getState().finish("original", "Late failure");
    expect(
      createProjectAgentCreationDraftStore(scope, storage).getState().attempts[0],
    ).toMatchObject({ accepted: receipt, error: null });
  });

  it("refuses a stale form after a different window starts a new intent or changes its settings", () => {
    const storage = memoryStorage();
    const first = createProjectAgentCreationDraftStore(scope, storage, () => "original");
    first.getState().updateDraft(draft);
    const second = createProjectAgentCreationDraftStore(scope, storage, () => "new");
    second.getState().updateDraft({ instructions: "Updated in another window" });
    expect(first.getState().beginCustom(input)).toBeNull();
    expect(first.getState().draft.value.instructions).toBe("Updated in another window");
    second.getState().newDraft(false);
    expect(first.getState().updateDraft({ label: "Stale edit" })).toBe(false);
    expect(first.getState().draft.value.label).toBe("");
    expect(first.getState().attempts).toEqual([]);
  });
});

describe("project agent creation storage failures", () => {
  it("retains malformed saved reasoning without overwriting or dispatching it", () => {
    for (const suffix of ["draft", "request:original"]) {
      const storage = memoryStorage();
      const prefix = projectAgentCreationScopeKey(scope);
      const malformed = { options: [{ id: "reasoning_effort", value: { changed: true } }] };
      const value =
        suffix === "draft"
          ? { intentId: "original", value: { ...draft, ...malformed } }
          : {
              origin: "custom",
              input: { ...input, requestId: "original", ...malformed },
              accepted: null,
              error: null,
            };
      const raw = JSON.stringify(value);
      storage.setItem(`${prefix}${suffix}`, raw);
      const store = createProjectAgentCreationDraftStore(scope, storage);
      expect(store.getState().error).not.toBeNull();
      expect(store.getState().beginPreset(input)).toBeNull();
      expect(storage.getItem(`${prefix}${suffix}`)).toBe(raw);
    }
  });

  it("keeps unsaved typing while refusing an undurable submission, then retries persistence", () => {
    const durable = memoryStorage();
    let fail = false;
    const storage = {
      ...durable,
      get length() {
        return durable.length;
      },
      setItem: (key: string, value: string) => {
        if (fail) throw new Error("quota");
        durable.setItem(key, value);
      },
    };
    const store = createProjectAgentCreationDraftStore(scope, storage, () => "original");
    store.getState().updateDraft(draft);
    fail = true;
    expect(store.getState().updateDraft({ instructions: "Unsaved typing" })).toBe(false);
    expect(store.getState().draft.value.instructions).toBe("Unsaved typing");
    expect(store.getState().beginCustom({ ...input, instructions: "Unsaved typing" })).toBeNull();
    expect(store.getState().attempts).toEqual([]);
    expect(
      createProjectAgentCreationDraftStore(scope, durable).getState().draft.value.instructions,
    ).toBe(input.instructions);
    fail = false;
    store.getState().updateDraft({ label: "Updated" });
    expect(
      createProjectAgentCreationDraftStore(scope, durable).getState().draft.value.instructions,
    ).toBe("Unsaved typing");
    expect(
      store.getState().beginCustom({ ...input, label: "Updated", instructions: "Unsaved typing" })
        ?.input.requestId,
    ).toBe("original");
  });

  it("requires request write/readback before dispatch and retains a failed acceptance for retry", () => {
    const durable = memoryStorage();
    let blockRequests = true;
    const storage = {
      ...durable,
      get length() {
        return durable.length;
      },
      setItem: (key: string, value: string) => {
        if (blockRequests && key.includes(":request:")) throw new Error("quota");
        durable.setItem(key, value);
      },
    };
    const store = createProjectAgentCreationDraftStore(scope, storage, () => "original");
    store.getState().updateDraft(draft);
    expect(store.getState().beginCustom(input)).toBeNull();
    expect(store.getState().pendingIds).toEqual([]);
    blockRequests = false;
    expect(store.getState().beginCustom(input)?.input.requestId).toBe("original");
    blockRequests = true;
    expect(store.getState().accept("original", receipt)).toBe(false);
    store.getState().finish("original");
    expect(
      createProjectAgentCreationDraftStore(scope, durable).getState().attempts[0]?.accepted,
    ).toBeNull();
    blockRequests = false;
    expect(store.getState().retry("original")?.input.requestId).toBe("original");
  });

  it("does not overwrite unreadable saved drafts or requests", () => {
    for (const suffix of ["draft", "request:original"]) {
      const storage = memoryStorage();
      const key = `${projectAgentCreationScopeKey(scope)}${suffix}`;
      storage.setItem(key, "unreadable retained bytes");
      const store = createProjectAgentCreationDraftStore(scope, storage);
      expect(store.getState().error).not.toBeNull();
      expect(store.getState().newDraft(false)).toBe(false);
      expect(store.getState().beginPreset(input)).toBeNull();
      expect(storage.getItem(key)).toBe("unreadable retained bytes");
    }
  });

  it("rejects a response from another environment-local target without erasing the original", () => {
    const store = createProjectAgentCreationDraftStore(scope, memoryStorage(), () => "original");
    store.getState().beginPreset(input);
    expect(
      store.getState().accept("original", { ...receipt, projectId: ProjectId.make("other") }),
    ).toBe(false);
    expect(store.getState().attempts[0]?.accepted).toBeNull();
  });
});
