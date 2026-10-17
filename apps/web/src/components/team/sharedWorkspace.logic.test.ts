import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type SharedWorkspaceSnapshot,
} from "@t3tools/contracts";
import {
  sharedHostStatus,
  sharedProjectRoster,
  sharedSpecialistDestination,
} from "./sharedWorkspace.logic";

const localEnvironmentId = EnvironmentId.make("local");
const localProjectId = ProjectId.make("catalog-checkout");
const now = "2026-10-16T12:00:00.000Z";
function snapshot(): SharedWorkspaceSnapshot {
  return {
    workspace: {
      workspaceId: "workspace",
      name: "Product",
      limits: { maxSpecialists: 20, maxSnapshotBytes: 1_048_576 },
      createdAt: now,
    },
    participant: { participantId: "alice", kind: "person", displayName: "Alice", createdAt: now },
    projects: ["catalog", "storefront"].map((id) => ({
      sharedProjectId: id,
      name: id,
      repository: `github.com/example/${id}`,
      aliases: [],
      forkOf: null,
      hostProjectId: ProjectId.make(`host-${id}`),
      createdAt: now,
    })),
    checkouts: [
      {
        checkoutId: "checkout",
        participantId: "alice",
        sharedProjectId: "catalog",
        localEnvironmentId,
        localProjectId,
        repository: "github.com/example/catalog",
        createdAt: now,
      },
    ],
    specialists: [
      {
        specialistId: "inventory",
        nativeTarget: {
          projectId: ProjectId.make("native-anchor"),
          instanceId: ProviderInstanceId.make("meerkat"),
          agentId: "native-agent",
        },
        label: "Inventory",
        assignments: ["catalog", "storefront"].map((sharedProjectId) => ({
          sharedProjectId,
          charter: "Own inventory contracts",
          paths: ["src/inventory"],
          tags: ["inventory"],
        })),
        assignmentVersion: 1,
        supersededAt: null,
        successorId: null,
        createdAt: now,
      },
    ],
  };
}
const projects = [{ environmentId: localEnvironmentId, projectId: localProjectId }];

describe("shared specialist navigation", () => {
  it("shows one identity when a logical project includes several attached checkouts", () => {
    const data = snapshot();
    const otherCheckout = {
      ...data.checkouts[0]!,
      checkoutId: "other-checkout",
      localProjectId: ProjectId.make("other-local-project"),
      sharedProjectId: "storefront",
    };
    const roster = sharedProjectRoster({ ...data, checkouts: [...data.checkouts, otherCheckout] }, [
      ...projects,
      { environmentId: localEnvironmentId, projectId: otherCheckout.localProjectId },
    ]);
    expect(roster).toHaveLength(1);
    expect(roster[0]?.checkouts).toHaveLength(2);
    expect(roster[0]?.projects.map((project) => project.sharedProjectId)).toEqual([
      "catalog",
      "storefront",
    ]);
  });

  it("never borrows another participant's local checkout association", () => {
    const data = snapshot();
    expect(
      sharedProjectRoster(
        {
          ...data,
          checkouts: data.checkouts.map((checkout) => ({ ...checkout, participantId: "bob" })),
        },
        projects,
      ),
    ).toEqual([]);
  });

  it("requires an explicit association but keeps superseded owners reachable", () => {
    const data = snapshot();
    expect(sharedProjectRoster({ ...data, checkouts: [] }, projects)).toEqual([]);
    expect(
      sharedProjectRoster(
        {
          ...data,
          specialists: data.specialists.map((specialist) => ({ ...specialist, supersededAt: now })),
        },
        projects,
      ),
    ).toHaveLength(1);
    expect(sharedProjectRoster({ ...data, participant: null }, projects)).toEqual([]);
  });

  it("opens the canonical host identity without changing the local task context", () => {
    const data = snapshot();
    expect(
      sharedSpecialistDestination(
        EnvironmentId.make("shared-host"),
        data.specialists[0]!,
        data.checkouts[0],
      ),
    ).toEqual({
      to: "/$environmentId/agents/$agentId",
      params: { environmentId: "shared-host", agentId: "inventory" },
      search: {
        project: "native-anchor",
        shared: true,
        checkoutEnvironment: "local",
        checkoutProject: "catalog-checkout",
        checkoutId: "checkout",
      },
    });
  });

  it("does not describe a retained directory as a live agent observation", () => {
    expect(sharedHostStatus("offline", true, null, false)).toBe("Host offline");
    expect(sharedHostStatus("reconnecting", true, null, true)).toBe("Reconnecting");
    expect(sharedHostStatus("connected", true, "Permission denied", false)).toBe(
      "Host unavailable",
    );
    expect(sharedHostStatus("connected", true, null, false)).toBe("Shared");
  });
});
