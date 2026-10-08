import type { ScopedThreadRef } from "@t3tools/contracts";
import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
import {
  threadPullRequestKeysEqual,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
import { type ComponentPropsWithoutRef, useEffect } from "react";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { useThreadShell } from "~/state/entities";
import { stackedThreadToast, toastManager, type ThreadToastData } from "./ui/toast";

function PendingLinkDescription({
  threadRef,
  pullRequest,
  description,
  onLinked,
}: {
  threadRef: ScopedThreadRef;
  pullRequest: NonNullable<ReturnType<typeof parseChangeRequestUrl>>;
  description: string;
  onLinked: () => void;
}) {
  const thread = useThreadShell(threadRef);
  const linked = visibleThreadPullRequests(thread?.pullRequests ?? []).some((link) =>
    threadPullRequestKeysEqual(link, pullRequest),
  );
  useEffect(() => {
    if (linked) onLinked();
  }, [linked, onLinked]);
  return description;
}

/** The toast owns recovery observation, including after its action toolbar unmounts. */
export function showCreatedPullRequestLinkWarning({
  toastId,
  status,
  threadRef,
  prUrl,
  prNumber,
  actionProps,
  data,
}: {
  toastId: string;
  status: "pending" | "not_saved";
  threadRef: ScopedThreadRef | null;
  prUrl: string | null;
  prNumber: number | undefined;
  actionProps?: ComponentPropsWithoutRef<"button">;
  data?: ThreadToastData;
}): void {
  const capturedThreadRef = threadRef === null ? null : { ...threadRef };
  const parsed = prUrl === null ? null : parseChangeRequestUrl(prUrl);
  const pullRequest = parsed?.number === prNumber ? parsed : null;
  let linked = false;
  let closed = false;
  let copyFeedback = "";

  const onLinked = () => {
    if (closed || linked) return;
    linked = true;
    render();
  };
  const copyUrl = async () => {
    if (closed || prUrl === null) return;
    const copied = await writeTextToClipboard(prUrl, "pull request URL").catch(() => false);
    if (closed) return;
    copyFeedback = copied
      ? "PR URL copied."
      : "Could not copy. Select the URL and copy it manually.";
    render();
  };
  function render() {
    if (closed) return;
    const guidance = linked
      ? "The pull request is available and its link is saved to this thread."
      : status === "pending"
        ? "The pull request is available. Saving its link to this thread is pending; the server will retry automatically. Keep the URL."
        : "The pull request is available, but its link could not be saved to this thread. Keep the URL and use Linked pull requests > Link pull request.";
    const description = [guidance, prUrl, copyFeedback].filter(Boolean).join("\n\n");
    toastManager.update(toastId, {
      ...stackedThreadToast({
        type: linked ? "success" : "warning",
        title: linked
          ? "Pull request link saved"
          : status === "pending"
            ? "Pull request link pending"
            : "Pull request link not saved",
        description:
          !linked && status === "pending" && capturedThreadRef !== null && pullRequest !== null ? (
            <PendingLinkDescription
              threadRef={capturedThreadRef}
              pullRequest={pullRequest}
              description={description}
              onLinked={onLinked}
            />
          ) : (
            description
          ),
        timeout: 0,
        ...(actionProps !== undefined ? { actionProps } : {}),
        data: {
          ...data,
          ...(capturedThreadRef === null ? {} : { threadRef: capturedThreadRef }),
          dismissAfterVisibleMs: linked ? 10_000 : 0,
          ...(prUrl === null
            ? {}
            : { secondaryActionProps: { children: "Copy PR URL", onClick: copyUrl } }),
        },
      }),
      onClose: () => {
        closed = true;
      },
    });
  }
  render();
}
