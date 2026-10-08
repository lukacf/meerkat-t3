import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { McpInvocationContext } from "./McpInvocationContext.ts";
import { McpSessionRegistry } from "./McpSessionRegistry.ts";
import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { applyCurrentBrowserPolicy, makeMcpAuthMiddleware } from "./McpHttpServer.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("env"),
  threadId: ThreadId.make("thread"),
  providerSessionId: "session",
  providerInstanceId: ProviderInstanceId.make("native"),
  capabilities: new Set(["preview", "pull-requests"]),
  issuedAt: 1,
};
it.effect("applies a project disable immediately to a previously issued browser credential", () =>
  Effect.gen(function* () {
    let enabled = true;
    const layers = Layer.mergeAll(
      Layer.mock(ProjectionSnapshotQuery)({
        getThreadShellById: () =>
          Effect.succeedSome({ projectId: ProjectId.make("project") } as OrchestrationThreadShell),
      }),
      Layer.mock(ServerSettingsService)({
        getSettings: Effect.sync(() => ({
          ...DEFAULT_SERVER_SETTINGS,
          enableAgentBrowserAccess: true,
          projectSettingsOverrides: { project: { enableAgentBrowserAccess: enabled } },
        })),
      }),
    );
    const read = applyCurrentBrowserPolicy(scope).pipe(Effect.provide(layers));
    expect((yield* read).capabilities.has("preview")).toBe(true);
    enabled = false;
    const denied = yield* read;
    expect(denied.capabilities.has("preview")).toBe(false);
    expect(denied.capabilities.has("pull-requests")).toBe(true);
    expect(scope.capabilities.has("preview")).toBe(true);
  }),
);
it.effect("withholds browser access when the owning thread no longer resolves", () =>
  Effect.gen(function* () {
    const denied = yield* applyCurrentBrowserPolicy(scope).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionSnapshotQuery)({ getThreadShellById: () => Effect.succeedNone }),
          Layer.mock(ServerSettingsService)({
            getSettings: Effect.succeed({
              ...DEFAULT_SERVER_SETTINGS,
              enableAgentBrowserAccess: true,
            }),
          }),
        ),
      ),
    );
    expect(denied.capabilities.has("preview")).toBe(false);
  }),
);

it.effect(
  "authenticates a pinned host witness and reapplies current policy on each HTTP request",
  () =>
    Effect.gen(function* () {
      const middleware = yield* makeMcpAuthMiddleware.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(McpSessionRegistry)({
              resolve: (token) => Effect.succeed(token === "valid" ? scope : undefined),
            }),
            Layer.mock(ProjectionSnapshotQuery)({
              getThreadShellById: () =>
                Effect.succeedSome({
                  projectId: ProjectId.make("project"),
                } as OrchestrationThreadShell),
            }),
            Layer.mock(ServerSettingsService)({
              getSettings: Effect.succeed({
                ...DEFAULT_SERVER_SETTINGS,
                enableAgentBrowserAccess: false,
              }),
            }),
          ),
        ),
      );
      const routed = yield* middleware(
        McpInvocationContext.pipe(
          Effect.map((value) =>
            HttpServerResponse.jsonUnsafe({
              pinned: value.previewHostConnectionId,
              preview: value.capabilities.has("preview"),
            }),
          ),
        ),
      ).pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(
            new Request("http://localhost/mcp", {
              headers: {
                authorization: "Bearer valid",
                "X-T3-Preview-Host": "original-generation",
              },
            }),
          ),
        ),
      );
      expect(routed.status).toBe(200);
      expect(routed.body._tag).toBe("Uint8Array");
      if (routed.body._tag === "Uint8Array")
        expect(yield* decodeJson(new TextDecoder().decode(routed.body.body))).toEqual({
          pinned: "original-generation",
          preview: false,
        });
      const rejected = yield* middleware(Effect.succeed(HttpServerResponse.empty())).pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(
            new Request("http://localhost/mcp", {
              headers: {
                authorization: "Bearer invalid",
                "X-T3-Preview-Host": "original-generation",
              },
            }),
          ),
        ),
      );
      expect(rejected.status).toBe(401);
    }),
);
