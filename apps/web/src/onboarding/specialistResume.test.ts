import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type { OnboardingProgress } from "@t3tools/contracts/settings";
import { expect, it } from "vite-plus/test";
import {
  onboardingResumeTarget,
  onboardingWorkspaceStep,
  resolveHostedFirstRunDecision,
} from "./firstRun.logic";
const projectRef = {
  environmentId: EnvironmentId.make("remote"),
  projectId: ProjectId.make("project"),
};
const progress: OnboardingProgress = {
  step: "project-agents",
  environmentIds: [projectRef.environmentId],
  startedAt: "2026-10-08T12:00:00.000Z",
  projectRef,
  threadId: ThreadId.make("setup"),
};
it("resumes a new or temporarily unprojected setup through proposal authority", () => {
  expect(onboardingResumeTarget(progress, [])).toEqual({
    to: "/$environmentId/projects/$projectId/agents/propose",
    params: projectRef,
    replace: true,
  });
  expect(
    onboardingResumeTarget(progress, [
      { id: "setup", environmentId: "remote", projectId: "other" },
    ]),
  ).toEqual(onboardingResumeTarget(progress, []));
  expect(
    onboardingResumeTarget(progress, [
      { id: "setup", environmentId: "local", projectId: "project" },
    ]),
  ).toEqual(onboardingResumeTarget(progress, []));
});
it("resumes an existing proposal conversation without creating or replacing a draft", () => {
  expect(
    onboardingResumeTarget(progress, [
      { id: "setup", environmentId: "remote", projectId: "project" },
    ]),
  ).toEqual({
    to: "/$environmentId/$threadId",
    params: { environmentId: "remote", threadId: "setup" },
    replace: true,
  });
});
it("keeps both old first-task resume cases compatible", () => {
  const legacy = { ...progress, step: "first-task" as const };
  expect(onboardingResumeTarget(legacy, [])?.to).toBe("/$environmentId/projects/$projectId/start");
  expect(
    onboardingResumeTarget(legacy, [{ id: "setup", environmentId: "remote", projectId: "project" }])
      ?.to,
  ).toBe("/$environmentId/$threadId");
});
it.each(["first-task", "project-agents"] as const)(
  "opens the app for a saved %s without marking it complete",
  (progressStep) => {
    expect(
      resolveHostedFirstRunDecision({
        hydrated: true,
        completed: false,
        progressStep,
        catalogReady: true,
        environmentCount: 1,
      }),
    ).toEqual({ decision: "app", persistCompletion: false });
  },
);

it("recovers older reviewed first-task records without tagging unstarted projects as legacy", () => {
  expect(onboardingWorkspaceStep({ ...progress, step: "projects" })).toBe("first-task");
  expect(onboardingWorkspaceStep({ ...progress, step: "projects", threadId: null })).toBe(
    "project-agents",
  );
  expect(
    onboardingWorkspaceStep({ ...progress, step: "agents", resumeStep: "project-agents" }),
  ).toBe("project-agents");
  expect(
    onboardingWorkspaceStep({
      ...progress,
      step: "agents",
      resumeStep: "first-task",
      threadId: null,
    }),
  ).toBe("first-task");
});
