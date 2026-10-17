import { describe, expect, it } from "vite-plus/test";
import { projectAgentRouteScope } from "./meerkatAgentNavigation";

describe("project agent navigation scope", () => {
  it("keeps local navigation while the shared specialist executes on its host", () => {
    expect(
      projectAgentRouteScope(
        "/shared-host/agents/inventory",
        "?shared=true&project=native-anchor&checkoutEnvironment=local&checkoutProject=feature-checkout",
      ),
    ).toEqual({ environmentId: "local", projectId: "feature-checkout" });
  });
  it("does not fall back to a host project when local context is absent", () => {
    expect(
      projectAgentRouteScope("/shared-host/agents/inventory", "?shared=true&project=native-anchor"),
    ).toBeNull();
  });
  it("preserves normal project agent and project-start navigation", () => {
    expect(projectAgentRouteScope("/local/agents/native-agent", "?project=catalog")).toEqual({
      environmentId: "local",
      projectId: "catalog",
    });
    expect(projectAgentRouteScope("/local/projects/catalog/start", "")).toEqual({
      environmentId: "local",
      projectId: "catalog",
    });
  });
});
