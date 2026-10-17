import {
  EnvironmentId,
  MeerkatProjectAgentCreateInput,
  ProjectId,
  SharedNativeTarget,
  SharedProject,
  SharedProjectRegisterInput,
  SharedSpecialist,
  type MeerkatProjectAgent,
  type SharedSpecialistRegisterInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { browserAgentDraftStorage, writeAgentDraftStorage } from "../team/agentDraftStorage";

const SpecialistAttempt = Schema.Struct({
  requestId: Schema.String,
  sharedProjectId: Schema.String,
  label: Schema.String,
  charter: Schema.String,
  create: Schema.NullOr(MeerkatProjectAgentCreateInput),
  target: Schema.NullOr(SharedNativeTarget),
  result: Schema.NullOr(SharedSpecialist),
});
export type SpecialistAttempt = typeof SpecialistAttempt.Type;
export const SharedHostSetup = Schema.Struct({
  environmentId: EnvironmentId,
  workspaceId: Schema.String,
  projectId: ProjectId,
  projectRequest: Schema.NullOr(SharedProjectRegisterInput),
  project: Schema.NullOr(SharedProject),
  specialist: Schema.NullOr(SpecialistAttempt),
});
export type SharedHostSetup = typeof SharedHostSetup.Type;
export type SharedHostSetupScope = Pick<
  SharedHostSetup,
  "environmentId" | "workspaceId" | "projectId"
>;
const decode = Schema.decodeUnknownSync(SharedHostSetup);

export function sharedHostSetupKey(scope: SharedHostSetupScope): string {
  return `meerkat-t3:shared-host-setup:v1:${JSON.stringify([scope.environmentId, scope.workspaceId, scope.projectId])}`;
}

export function readSharedHostSetup(scope: SharedHostSetupScope): SharedHostSetup {
  const storage = browserAgentDraftStorage("localStorage");
  if (!storage)
    throw new Error("Local storage is unavailable. Setup is paused so retry IDs cannot be lost.");
  const raw = storage.getItem(sharedHostSetupKey(scope));
  if (!raw) return { ...scope, projectRequest: null, project: null, specialist: null };
  const setup = decode(JSON.parse(raw));
  if (
    setup.environmentId !== scope.environmentId ||
    setup.workspaceId !== scope.workspaceId ||
    setup.projectId !== scope.projectId
  )
    throw new Error("The saved setup belongs to another host or project. Its data has been kept.");
  if (setup.projectRequest && setup.projectRequest.hostProjectId !== scope.projectId)
    throw new Error("The saved project registration does not match this checkout.");
  const attempt = setup.specialist;
  if (
    attempt &&
    ((attempt.create &&
      (attempt.create.projectId !== scope.projectId ||
        attempt.create.accessMode !== "repository-read-only")) ||
      (attempt.target && attempt.target.projectId !== scope.projectId) ||
      (!attempt.create && !attempt.target))
  )
    throw new Error("The saved specialist binding is invalid. Its data has been kept.");
  return setup;
}

export function saveSharedHostSetup(setup: SharedHostSetup): boolean {
  try {
    const current = readSharedHostSetup(setup);
    // Another tab may have saved an uncertain request since this form was opened.
    if (
      current.specialist &&
      !current.specialist.result &&
      current.specialist.requestId !== setup.specialist?.requestId
    )
      return false;
    if (
      current.projectRequest &&
      !current.project &&
      current.projectRequest.requestId !== setup.projectRequest?.requestId
    )
      return false;
  } catch {
    return false;
  }
  return writeAgentDraftStorage(
    browserAgentDraftStorage("localStorage"),
    sharedHostSetupKey(setup),
    setup,
  );
}

/** Each step has its original identity saved before it can reach the host. */
export async function registerHostProject(
  setup: SharedHostSetup,
  actions: {
    persist: (setup: SharedHostSetup) => boolean;
    register: (input: SharedProjectRegisterInput) => Promise<SharedProject>;
  },
): Promise<SharedHostSetup> {
  if (!setup.projectRequest) throw new Error("Choose a project before registering it.");
  if (!actions.persist(setup))
    throw new Error("The registration request could not be saved. Nothing was sent.");
  const project = await actions.register(setup.projectRequest);
  if (
    project.hostProjectId !== setup.projectId ||
    project.repository !== setup.projectRequest.repository
  )
    throw new Error(
      "The host returned a different project registration. Refresh before continuing.",
    );
  const next = { ...setup, project };
  if (!actions.persist(next))
    throw new Error(
      "The project was registered, but its result could not be saved. Retry to recover the same registration.",
    );
  return next;
}

export async function registerHostSpecialist(
  setup: SharedHostSetup,
  actions: {
    persist: (setup: SharedHostSetup) => boolean;
    create: (input: MeerkatProjectAgentCreateInput) => Promise<MeerkatProjectAgent>;
    connect: (target: SharedNativeTarget) => Promise<MeerkatProjectAgent>;
    register: (input: SharedSpecialistRegisterInput) => Promise<SharedSpecialist>;
  },
): Promise<SharedHostSetup> {
  let attempt = setup.specialist;
  if (!attempt) throw new Error("Choose a specialist before sharing it.");
  if (attempt.result) return setup;
  if (setup.project && setup.project.sharedProjectId !== attempt.sharedProjectId)
    throw new Error("The specialist request belongs to another shared project.");
  const persist = () => {
    setup = { ...setup, specialist: attempt };
    if (!actions.persist(setup))
      throw new Error(
        "The specialist setup could not be saved. Retry from this saved request when local storage is available.",
      );
  };
  persist();
  if (!attempt.target) {
    if (
      !attempt.create ||
      attempt.create.projectId !== setup.projectId ||
      attempt.create.accessMode !== "repository-read-only"
    )
      throw new Error(
        "Shared specialists require a repository-only creation request for this project.",
      );
    const agent = await actions.create(attempt.create);
    if (
      agent.projectId !== setup.projectId ||
      agent.instanceId !== attempt.create.instanceId ||
      agent.accessMode !== "repository-read-only"
    )
      throw new Error("The created agent does not match the saved specialist request.");
    attempt = {
      ...attempt,
      target: { projectId: agent.projectId, instanceId: agent.instanceId, agentId: agent.agentId },
    };
    persist();
  }
  const target = attempt.target!;
  if (target.projectId !== setup.projectId)
    throw new Error("The specialist belongs to another host project.");
  const connected = await actions.connect(target);
  if (
    connected.agentId !== target.agentId ||
    connected.projectId !== target.projectId ||
    connected.instanceId !== target.instanceId ||
    connected.accessMode !== "repository-read-only" ||
    connected.connectionStatus !== "connected"
  )
    throw new Error(
      connected.error ??
        "This specialist is not connected with repository-only access. Retry when it is available.",
    );
  const result = await actions.register({
    requestId: attempt.requestId,
    nativeTarget: target,
    label: attempt.label,
    assignments: [
      { sharedProjectId: attempt.sharedProjectId, charter: attempt.charter, paths: [], tags: [] },
    ],
  });
  if (
    result.nativeTarget.agentId !== target.agentId ||
    result.nativeTarget.projectId !== target.projectId ||
    result.nativeTarget.instanceId !== target.instanceId
  )
    throw new Error(
      "The host returned a different specialist binding. The original request has been kept.",
    );
  attempt = { ...attempt, result };
  persist();
  return setup;
}
