import { createFileRoute } from "@tanstack/react-router";

// The shared layout keeps the same ChatView alive when first send promotes
// this project's local draft to its durable thread route.
export const Route = createFileRoute("/_chat/$environmentId/projects/$projectId/start")({
  component: () => null,
});
