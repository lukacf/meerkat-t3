import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import { it } from "@effect/vitest";
import { describe, expect, vi } from "vite-plus/test";
import { ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import type { MeerkatGatewayClient } from "./MeerkatGatewayClient.ts";
import { makeMeerkatTextGeneration } from "./MeerkatTextGeneration.ts";

const instanceId = ProviderInstanceId.make("meerkat");
const modelSelection = createModelSelection(instanceId, "anthropic:claude-sonnet-4-6", [
  { id: "effort", value: "high" },
]);
const build = (output: unknown, enabled = true) =>
  Effect.gen(function* () {
    const request = vi.fn<MeerkatGatewayClient["request"]>(async (method) =>
      method === "models.v1.catalog"
        ? {
            catalog: {
              providers: [
                {
                  provider: "openai",
                  models: [
                    {
                      id: "gpt-native",
                      profile: {
                        params_schema: {
                          properties: {
                            reasoning_effort: { type: "string", enum: ["low", "high"] },
                            prompt_cache_enabled: { type: "boolean" },
                          },
                        },
                      },
                    },
                  ],
                },
              ],
            },
          }
        : { output },
    );
    const prepareWorkspace = vi.fn(async () => {});
    const service = yield* makeMeerkatTextGeneration({
      client: { request } as unknown as MeerkatGatewayClient,
      instanceId,
      stateRoot: "/state",
      enabled,
      attachmentsDir: "/attachments",
      prepareWorkspace,
    });
    return { service, request, prepareWorkspace };
  });

describe("Meerkat text generation", () => {
  it.effect("generates all four writing results through the selected native provider", () =>
    Effect.gen(function* () {
      const commit = yield* build({
        subject: " Fix parser. ",
        body: " Tests updated. ",
        branch: "parser improvements",
      });
      expect(
        yield* commit.service.generateCommitMessage({
          cwd: "/repo",
          branch: "main",
          stagedSummary: "parser",
          stagedPatch: "+ fixed",
          includeBranch: true,
          modelSelection,
        }),
      ).toEqual({
        subject: "Fix parser",
        body: "Tests updated.",
        branch: "feature/parser-improvements",
      });
      const pr = yield* build({ title: " Parser change\nextra", body: " Summary " });
      expect(
        yield* pr.service.generatePrContent({
          cwd: "/repo",
          baseBranch: "main",
          headBranch: "fix",
          commitSummary: "fix",
          diffSummary: "one file",
          diffPatch: "+ fixed",
          modelSelection,
        }),
      ).toEqual({ title: "Parser change", body: "Summary" });
      const branch = yield* build({ branch: "Improve Parser" });
      expect(
        yield* branch.service.generateBranchName({
          cwd: "/repo",
          message: "Improve parser",
          modelSelection,
        }),
      ).toEqual({ branch: "improve-parser" });
      const title = yield* build({ title: '"Improve parser"', needsRefinement: true });
      expect(
        yield* title.service.generateThreadTitle({
          cwd: "/repo",
          message: "Improve parser",
          modelSelection,
        }),
      ).toEqual({ title: "Improve parser", needsRefinement: true });
      for (const fixture of [commit, pr, branch, title]) {
        expect(fixture.request).toHaveBeenCalledTimes(1);
        expect(fixture.prepareWorkspace).toHaveBeenCalledWith(
          "/repo",
          expect.stringContaining("/state/projects/"),
        );
        expect(fixture.request).toHaveBeenCalledWith(
          "text.v1.generate",
          expect.objectContaining({
            projectPath: "/repo",
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            providerParams: { effort: "high" },
            outputSchema: expect.objectContaining({ type: "object" }),
            images: [],
          }),
          expect.objectContaining({ timeoutMs: 95_000 }),
        );
      }
    }).pipe(Effect.provide(Path.layer)),
  );

  for (const effort of ["low", "high"] as const) {
    it.effect(`delegates cache defaults for auxiliary generation with ${effort} reasoning`, () =>
      Effect.gen(function* () {
        const fixture = yield* build({ title: "Review parser" });
        const selection = createModelSelection(instanceId, "openai:gpt-native", [
          { id: "reasoning_effort", value: effort },
          { id: "prompt_cache_enabled", value: false },
        ]);
        yield* fixture.service.generateThreadTitle({
          cwd: "/repo",
          message: "Review parser",
          modelSelection: selection,
        });
        expect(fixture.request.mock.calls.map(([method]) => method)).toEqual([
          "models.v1.catalog",
          "text.v1.generate",
        ]);
        expect(fixture.request.mock.calls[1]?.[1]).toMatchObject({
          projectPath: "/repo",
          provider: "openai",
          model: "gpt-native",
        });
        expect(fixture.request.mock.calls[1]?.[1]?.providerParams).toEqual({
          reasoning_effort: effort,
        });
        expect(selection.options?.find((entry) => entry.id === "prompt_cache_enabled")?.value).toBe(
          false,
        );
      }).pipe(Effect.provide(Path.layer)),
    );
  }

  for (const kind of ["disabled", "unqualified", "wrong-instance", "invalid-output"] as const) {
    it.effect(`rejects ${kind} without alternate-provider calls`, () =>
      Effect.gen(function* () {
        const fixture = yield* build({ wrong: "shape" }, kind !== "disabled");
        const result = yield* fixture.service
          .generateBranchName({
            cwd: "/repo",
            message: "Update parser",
            modelSelection:
              kind === "unqualified"
                ? createModelSelection(instanceId, "claude-sonnet-4-6")
                : kind === "wrong-instance"
                  ? createModelSelection(ProviderInstanceId.make("other"), modelSelection.model)
                  : modelSelection,
          })
          .pipe(Effect.result);
        expect(Result.isFailure(result)).toBe(true);
        expect(fixture.request).toHaveBeenCalledTimes(kind === "invalid-output" ? 1 : 0);
      }).pipe(Effect.provide(Path.layer)),
    );
  }

  it.effect("carries image attachment paths through the private native boundary", () =>
    Effect.gen(function* () {
      const fixture = yield* build({ title: "Align toolbar", needsRefinement: false });
      yield* fixture.service.generateThreadTitle({
        cwd: "/repo",
        message: "Fix this",
        modelSelection,
        attachments: [
          {
            id: "thread-11111111-1111-4111-8111-111111111111",
            type: "image",
            name: "screen.png",
            mimeType: "image/png",
            sizeBytes: 100,
          },
        ],
      });
      expect(fixture.request.mock.calls[0]?.[1]?.images).toEqual([
        { path: expect.stringContaining("/attachments/"), mediaType: "image/png" },
      ]);
    }).pipe(Effect.provide(Path.layer)),
  );
});
