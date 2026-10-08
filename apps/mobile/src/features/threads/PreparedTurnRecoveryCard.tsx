import type { EnvironmentId, ThreadId, ThreadPreparedTurn } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { StackActions, useNavigation } from "@react-navigation/native";

import { AppText as Text } from "../../components/AppText";
import {
  preparedTurnCanEdit,
  preparedTurnEditBlock,
  preparedTurnNeedsSetupAcknowledgement,
} from "../../state/prepared-turn-recovery";
import { usePreparedTurnRecovery } from "../../state/use-prepared-turn-recovery";
import { RequestActionButton } from "./RequestActionButton";
import { useComposerDraft } from "../../state/use-composer-drafts";
import { restoredNewTaskDraftKey } from "../../state/new-task-draft-key";
import { useThreadOutboxMessages } from "../../state/use-thread-outbox";
import { scopedThreadKey } from "../../lib/scopedEntities";

export function PreparedTurnRecoveryCard(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly prepared: ThreadPreparedTurn;
  readonly connected: boolean;
  readonly setupActive: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const recovery = usePreparedTurnRecovery(props);
  const navigation = useNavigation();
  const copyKey = restoredNewTaskDraftKey(props.prepared.command.message.messageId);
  const queuedCopy = useComposerDraft(copyKey);
  const hasQueuedCopy =
    queuedCopy.project?.environmentId === props.environmentId &&
    queuedCopy.project.projectId === props.prepared.projectId &&
    (queuedCopy.text.length > 0 || queuedCopy.attachments.length > 0);
  const queue =
    useThreadOutboxMessages()[scopedThreadKey(props.environmentId, props.threadId)] ?? [];
  const { prepared } = props;
  const released = prepared.phase === "released";
  const needsAcknowledgement = preparedTurnNeedsSetupAcknowledgement(prepared);
  const editBlock = preparedTurnEditBlock(prepared);
  const model = prepared.command.modelSelection;
  return (
    <View className="px-4 pb-3">
      <View className="gap-3 rounded-[20px] border border-border-subtle bg-card p-4">
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          onPress={() => setExpanded((value) => !value)}
          className="gap-1 active:opacity-70"
        >
          <Text className="font-t3-bold text-sm text-foreground">
            {released ? "Original message saved" : "Message needs attention"}
          </Text>
          <Text numberOfLines={2} className="text-xs text-foreground-muted">
            {released
              ? "Edit restores the original into an empty composer. Your current draft is kept."
              : (prepared.reason ??
                "Checkout preparation has not finished. Your original message is saved.")}
          </Text>
          <Text className="text-xs text-primary">
            {expanded ? "Hide saved request" : "View saved request"}
          </Text>
        </Pressable>
        {expanded ? (
          <ScrollView style={{ maxHeight: 200 }} nestedScrollEnabled>
            <View className="gap-2">
              <Text selectable className="text-sm text-foreground">
                {prepared.command.message.text || "Message with attachments"}
              </Text>
              {prepared.command.message.attachments.map((attachment) => (
                <Text key={attachment.id} selectable className="text-xs text-foreground-muted">
                  {attachment.name} ({attachment.type})
                </Text>
              ))}
              {prepared.command.message.context?.records.map((record) => (
                <Text key={record.contextId} selectable className="text-xs text-foreground-muted">
                  {record.label} ({record.kind})
                </Text>
              ))}
              <Text selectable className="text-xs text-foreground-muted">
                Model: {model?.model ?? "Saved thread model"}
              </Text>
              {model?.options
                ?.filter((option) => option.id === "effort" || /reasoning|thinking/.test(option.id))
                .map((option) => (
                  <Text key={option.id} selectable className="text-xs text-foreground-muted">
                    Reasoning level:{" "}
                    {String(option.value)
                      .replaceAll("_", " ")
                      .replace(/^./, (letter) => letter.toUpperCase())}
                  </Text>
                ))}
              <Text selectable className="text-xs text-foreground-muted">
                Checkout: {prepared.expectedCwd ?? prepared.projectCwd}
              </Text>
              {prepared.reason ? (
                <Text selectable className="text-xs text-foreground-muted">
                  {prepared.reason}
                </Text>
              ) : null}
            </View>
          </ScrollView>
        ) : null}
        {!released && needsAcknowledgement ? (
          <Pressable
            accessibilityRole="checkbox"
            accessibilityState={{ checked: acknowledged, disabled: recovery.busy }}
            disabled={recovery.busy}
            onPress={() => setAcknowledged((value) => !value)}
            className="flex-row items-start gap-2"
          >
            <Text className="text-sm text-primary">{acknowledged ? "[x]" : "[ ]"}</Text>
            <Text className="flex-1 text-xs text-foreground-muted">
              I checked the interrupted setup. Continue without running it again.
            </Text>
          </Pressable>
        ) : null}
        {!props.connected ? (
          <Text className="text-xs text-foreground-muted">Reconnect to recover this message.</Text>
        ) : null}
        {recovery.hasDraft ? (
          <Text className="text-xs text-foreground-muted">
            Keep or move your current draft before using Edit.
          </Text>
        ) : null}
        {editBlock ? <Text className="text-xs text-foreground-muted">{editBlock}</Text> : null}
        {recovery.error ? (
          <Text accessibilityLiveRegion="polite" selectable className="text-xs text-danger">
            {recovery.error}
          </Text>
        ) : null}
        {hasQueuedCopy ? (
          <Text className="text-xs text-foreground-muted">
            A queued copy, including any edits, is kept separately in Drafts. It will not send
            automatically.
          </Text>
        ) : null}
        {released &&
        queue.some((message) => message.replacesPreparedRecoveryId !== prepared.recoveryId) ? (
          <Text className="text-xs text-foreground-muted">
            Queued follow-ups will wait until you send a replacement for the saved request.
          </Text>
        ) : null}
        <View className="flex-row flex-wrap gap-2">
          {!released ? (
            <RequestActionButton
              label={recovery.action === "retry" ? "Retrying..." : "Retry original"}
              disabled={
                !props.connected ||
                recovery.busy ||
                prepared.phase !== "blocked" ||
                !prepared.expectedCwd ||
                (props.setupActive && prepared.setup !== "async_running") ||
                (needsAcknowledgement && !acknowledged)
              }
              onPress={() => {
                void recovery.retry(acknowledged);
              }}
            />
          ) : null}
          <RequestActionButton
            label={recovery.action === "edit" ? "Restoring..." : "Edit"}
            tone="secondary"
            disabled={
              !props.connected ||
              recovery.busy ||
              recovery.hasDraft ||
              props.setupActive ||
              !preparedTurnCanEdit(prepared) ||
              editBlock !== null
            }
            onPress={() => {
              void recovery.edit();
            }}
          />
          {hasQueuedCopy ? (
            <RequestActionButton
              label="Review queued copy"
              tone="secondary"
              disabled={recovery.busy}
              onPress={() =>
                navigation.dispatch(
                  StackActions.replace("NewTaskSheet", {
                    screen: "NewTaskDraft",
                    params: {
                      draftId: copyKey,
                      environmentId: String(props.environmentId),
                      projectId: String(prepared.projectId),
                    },
                  }),
                )
              }
            />
          ) : null}
        </View>
      </View>
    </View>
  );
}
