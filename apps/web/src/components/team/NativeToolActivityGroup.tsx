import { ChevronRightIcon, WrenchIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { ConversationActivity } from "./agentActivity.logic";
import type { NativeHistoryDisclosures } from "./nativeHistoryDisclosures";
import type { NativeToolActivityGroup as ActivityGroup } from "./nativeToolActivity.logic";
import { currentNativeToolActivity } from "./nativeToolActivity.logic";
import { nativeToolInvocations } from "./nativeToolInvocations";
import { isCurrentNativeQuestion } from "./nativeQuestionStatus";

export function NativeToolActivityGroup({
  group,
  disclosures,
  renderActivity,
  nativeRunId,
  pendingQuestionToolCallIds,
}: {
  group: ActivityGroup;
  disclosures: NativeHistoryDisclosures;
  renderActivity: (
    activity: ConversationActivity,
    rowId: string,
    questionPending?: boolean,
  ) => ReactNode;
  nativeRunId?: string | undefined;
  pendingQuestionToolCallIds?: ReadonlySet<string> | undefined;
}) {
  const open = disclosures.expanded.has(`tools:${group.id}`);
  const labels = group.labels.join(", ");
  const current = currentNativeToolActivity(group, nativeRunId);
  const questionPending = (activity: ConversationActivity) =>
    isCurrentNativeQuestion(activity, nativeRunId, pendingQuestionToolCallIds);
  const needsInput = current.some(questionPending);
  return (
    <article className="px-5 py-2" data-agent-tool-group-id={group.id}>
      <details
        open={open}
        onToggle={(event) =>
          disclosures.toggle(`tools:${group.id}`, event.currentTarget.open, group.id)
        }
        className="group/tool-activity text-xs"
      >
        <summary
          className="flex cursor-pointer list-none items-center gap-2 py-2 text-muted-foreground [&::-webkit-details-marker]:hidden"
          onClick={() => disclosures.prepare(group.id)}
        >
          <ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-open/tool-activity:rotate-90" />
          <WrenchIcon className="size-3.5 shrink-0" />
          <span className="shrink-0 font-medium">{needsInput ? "Question" : "Tool activity"}</span>
          {needsInput ? (
            <span className="min-w-0 truncate">Waiting for your answer</span>
          ) : labels ? (
            <span className="min-w-0 truncate">{labels}</span>
          ) : null}
        </summary>
        {open ? (
          <div className="ml-1.5 space-y-1 border-l border-border/70 py-1 pl-4">
            {nativeToolInvocations(group.activities, group.invocationIndex).map((invocation) => (
              <div key={invocation.id}>
                {renderActivity(
                  invocation.activity,
                  group.id,
                  questionPending(invocation.activity),
                )}
                {invocation.records.length > 1 ? (
                  <details
                    className="pl-4 text-muted-foreground"
                    open={disclosures.expanded.has(`records:${invocation.id}`)}
                    onToggle={(event) =>
                      disclosures.toggle(
                        `records:${invocation.id}`,
                        event.currentTarget.open,
                        group.id,
                      )
                    }
                  >
                    <summary
                      className="cursor-pointer py-1"
                      onClick={() => disclosures.prepare(group.id)}
                    >
                      Native event records ({invocation.records.length})
                    </summary>
                    {disclosures.expanded.has(`records:${invocation.id}`)
                      ? invocation.records.map((activity) => (
                          <div key={activity.id}>{renderActivity(activity, group.id)}</div>
                        ))
                      : null}
                  </details>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </details>
      {!open
        ? current.map((activity) => (
            <p key={activity.id} role="status" className="ml-6 py-1 text-xs text-muted-foreground">
              {questionPending(activity) ? "Needs input" : `${activity.label}: ${activity.status}`}
            </p>
          ))
        : null}
      {!open
        ? group.failures.map((failure) => (
            <p
              key={failure.id}
              role={failure.status === "Failed" ? "alert" : "status"}
              className={`ml-6 line-clamp-2 py-1 text-xs ${failure.status === "Failed" ? "text-destructive" : "text-muted-foreground"}`}
            >
              {failure.label}: {failure.status}
              {failure.output ? ` - ${failure.output}` : ""}
            </p>
          ))
        : null}
    </article>
  );
}
