import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type MeerkatProjectAgent,
  type SharedProject,
  type SharedSpecialist,
  type SharedSpecialistRegisterInput,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  readSharedHostSetup,
  registerHostProject,
  registerHostSpecialist,
  saveSharedHostSetup,
  sharedHostSetupKey,
  type SharedHostSetup,
} from "./sharedHostSetup";

const now = "2026-10-17T08:00:00.000Z";
const projectId = ProjectId.make("host-catalog");
const instanceId = ProviderInstanceId.make("runtime");
const project: SharedProject = {
  sharedProjectId: "catalog",
  hostProjectId: projectId,
  name: "Catalog",
  repository: "github.com/example/catalog",
  aliases: [],
  forkOf: null,
  createdAt: now,
};
const agent: MeerkatProjectAgent = {
  projectId,
  instanceId,
  agentId: "native-search",
  label: "Search",
  role: "search",
  instructions: "Own search relevance",
  model: "catalog-model",
  accessMode: "repository-read-only",
  enabled: true,
  archived: false,
  connectionStatus: "connected",
  error: null,
  agentRef: null,
  createdAt: now,
  updatedAt: now,
};
const target = { projectId, instanceId, agentId: agent.agentId };
function setup(): SharedHostSetup {
  return {
    environmentId: EnvironmentId.make("host"),
    workspaceId: "product",
    projectId,
    projectRequest: {
      requestId: "register-project",
      hostProjectId: projectId,
      name: "Catalog",
      repository: project.repository,
    },
    project,
    specialist: {
      requestId: "share-search",
      sharedProjectId: project.sharedProjectId,
      label: agent.label,
      charter: agent.instructions,
      create: {
        requestId: "create-search",
        projectId,
        instanceId,
        label: agent.label,
        role: agent.role,
        instructions: agent.instructions,
        model: agent.model,
        accessMode: "repository-read-only",
      },
      target: null,
      result: null,
    },
  };
}
const registered = (input: SharedSpecialistRegisterInput): SharedSpecialist => ({
  specialistId: "shared-search",
  nativeTarget: input.nativeTarget,
  label: input.label,
  assignments: input.assignments,
  assignmentVersion: 0,
  supersededAt: null,
  successorId: null,
  createdAt: now,
});
beforeEach(() => {
  const rows = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => rows.get(key) ?? null,
    setItem: (key: string, value: string) => rows.set(key, value),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("shared host setup recovery", () => {
  it("saves both request identities before creating, then saves the native binding before registering", async () => {
    const order: string[] = [];
    const initial = setup();
    const create = vi.fn(async () => {
      order.push("create");
      expect(readSharedHostSetup(initial).specialist?.create?.requestId).toBe("create-search");
      return agent;
    });
    const result = await registerHostSpecialist(initial, {
      persist: (value) => {
        order.push(
          value.specialist?.result
            ? "save-result"
            : value.specialist?.target
              ? "save-target"
              : "save-request",
        );
        return saveSharedHostSetup(value);
      },
      create,
      connect: async () => {
        order.push("connect");
        return agent;
      },
      register: async (input) => {
        order.push("register");
        expect(readSharedHostSetup(initial).specialist?.target).toEqual(target);
        return registered(input);
      },
    });
    expect(order).toEqual([
      "save-request",
      "create",
      "save-target",
      "connect",
      "register",
      "save-result",
    ]);
    expect(result.specialist?.result?.specialistId).toBe("shared-search");
    expect(readSharedHostSetup(initial)).toEqual(result);
  });
  it("retries a lost creation response using the original immutable model and request", async () => {
    const initial = setup();
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValue(agent);
    const actions = {
      persist: saveSharedHostSetup,
      create,
      connect: vi.fn(async () => agent),
      register: vi.fn(async (input: SharedSpecialistRegisterInput) => registered(input)),
    };
    await expect(registerHostSpecialist(initial, actions)).rejects.toThrow("response lost");
    await registerHostSpecialist(readSharedHostSetup(initial), actions);
    expect(create.mock.calls[0]).toEqual(create.mock.calls[1]);
    expect(create.mock.calls[1]![0].model).toBe("catalog-model");
  });
  it("keeps the existing native agent after a failed registration and retries the same registration", async () => {
    const initial = setup();
    const create = vi.fn(async () => agent);
    const register = vi
      .fn<(input: SharedSpecialistRegisterInput) => Promise<SharedSpecialist>>()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockImplementation(async (input) => registered(input));
    const actions = {
      persist: saveSharedHostSetup,
      create,
      connect: vi.fn(async () => agent),
      register,
    };
    await expect(registerHostSpecialist(initial, actions)).rejects.toThrow("response lost");
    expect(readSharedHostSetup(initial).specialist?.target).toEqual(target);
    await registerHostSpecialist(readSharedHostSetup(initial), actions);
    expect(create).toHaveBeenCalledTimes(1);
    expect(register.mock.calls[0]).toEqual(register.mock.calls[1]);
  });
  it("registers an existing repository-only agent without creating one", async () => {
    const saved = setup();
    const initial = { ...saved, specialist: { ...saved.specialist!, create: null, target } };
    const create = vi.fn();
    await registerHostSpecialist(initial, {
      persist: saveSharedHostSetup,
      create,
      connect: async () => agent,
      register: async (input) => registered(input),
    });
    expect(create).not.toHaveBeenCalled();
  });
  it("stops before creating when local storage cannot preserve retry IDs", async () => {
    const create = vi.fn();
    await expect(
      registerHostSpecialist(setup(), {
        persist: () => false,
        create,
        connect: vi.fn(),
        register: vi.fn(),
      }),
    ).rejects.toThrow("could not be saved");
    expect(create).not.toHaveBeenCalled();
  });
  it("does not register after the saved native binding cannot be persisted", async () => {
    const register = vi.fn();
    const connect = vi.fn();
    await expect(
      registerHostSpecialist(setup(), {
        persist: (value) => !value.specialist?.target,
        create: async () => agent,
        connect,
        register,
      }),
    ).rejects.toThrow("could not be saved");
    expect(connect).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });
  it.each([
    { accessMode: "full-access" as const },
    { connectionStatus: "error" as const },
    { instanceId: ProviderInstanceId.make("other") },
  ])("does not share an agent whose live binding is unsuitable: %j", async (change) => {
    const register = vi.fn();
    await expect(
      registerHostSpecialist(setup(), {
        persist: saveSharedHostSetup,
        create: async () => agent,
        connect: async () => ({ ...agent, ...change }),
        register,
      }),
    ).rejects.toThrow();
    expect(register).not.toHaveBeenCalled();
  });
  it("preserves an uncertain request when a second tab tries a different setup", () => {
    const initial = setup();
    expect(saveSharedHostSetup(initial)).toBe(true);
    expect(
      saveSharedHostSetup({
        ...initial,
        specialist: { ...initial.specialist!, requestId: "different" },
      }),
    ).toBe(false);
    expect(readSharedHostSetup(initial).specialist?.requestId).toBe("share-search");
  });
  it("does not discard malformed saved state or a cross-host binding", () => {
    const initial = setup();
    localStorage.setItem(
      sharedHostSetupKey(initial),
      JSON.stringify({ ...initial, environmentId: "another-host" }),
    );
    expect(() => readSharedHostSetup(initial)).toThrow("another host");
    expect(saveSharedHostSetup(initial)).toBe(false);
  });
  it("recovers the same project registration after a lost response", async () => {
    const initial = { ...setup(), project: null, specialist: null };
    const register = vi
      .fn()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValue(project);
    await expect(
      registerHostProject(initial, { persist: saveSharedHostSetup, register }),
    ).rejects.toThrow("response lost");
    const result = await registerHostProject(readSharedHostSetup(initial), {
      persist: saveSharedHostSetup,
      register,
    });
    expect(register.mock.calls[0]).toEqual(register.mock.calls[1]);
    expect(result.project).toEqual(project);
  });
  it("does not accept a registration for a different canonical repository", async () => {
    await expect(
      registerHostProject(setup(), {
        persist: saveSharedHostSetup,
        register: async () => ({ ...project, repository: "github.com/example/fork" }),
      }),
    ).rejects.toThrow("different project");
  });
});
