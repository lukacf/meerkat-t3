import { validateNativeAttentionLocation } from "../components/team/meerkatAttention.logic";
import { createFileRoute } from "@tanstack/react-router";
import { validateNativeSearchLocation } from "../components/team/nativeSearchNavigation";

// The view lives in the `_chat` layout (see ThreadRouteView) so a draft's
// promotion onto this route keeps the same ChatView mounted.
export const Route = createFileRoute("/_chat/$environmentId/$threadId")({
  validateSearch: (search: Record<string, unknown>) => ({
    ...(typeof search.member === "string" && search.member ? { member: search.member } : {}),
    ...validateNativeSearchLocation(search),
    ...validateNativeAttentionLocation(search),
  }),
  component: () => null,
});
