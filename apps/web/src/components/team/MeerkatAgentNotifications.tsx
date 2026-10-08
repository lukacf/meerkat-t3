import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { getClientSettings, useClientSettings } from "../../hooks/useSettings";
import { useMeerkatAttention } from "../../state/meerkatAttention";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  playNotificationSound,
} from "../../threadNotifications";
import { toastManager } from "../ui/toast";
import { nativeAttentionDestination } from "./meerkatAttention.logic";

export function MeerkatAgentNotifications({
  environmentId,
  projectId,
  onNotification,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  onNotification: (environmentId: EnvironmentId, notification: Notification) => void;
}) {
  const query = useMeerkatAttention(environmentId, projectId, undefined, true);
  const mode = useClientSettings((settings) => settings.notificationMode);
  const inApp = useClientSettings((settings) => settings.inAppNotificationsEnabled);
  const navigate = useNavigate();
  const search = useSearch({ strict: false });
  const seen = useRef(new Set<string>());
  useEffect(() => {
    if (!query.data || query.error) return;
    for (const item of query.data.items) {
      if (!item.active || !item.unread || seen.current.has(item.id)) continue;
      seen.current.add(item.id);
      if (search.attention === item.id) continue;
      // Ordinary coordinator completion already has the donor thread notification.
      if (item.coordinator && item.kind === "completion") continue;
      const destination = nativeAttentionDestination(environmentId, item);
      if (!destination) continue;
      const kind =
        item.kind === "completion" && item.completionStatus === "completed"
          ? "completion"
          : "input";
      const open = () => {
        void navigate(destination);
      };
      if (hasNotificationSound(mode))
        void playNotificationSound(kind, () =>
          hasNotificationSound(getClientSettings().notificationMode),
        );
      const foreground = document.visibilityState === "visible" && document.hasFocus();
      if (inApp && foreground) {
        const id = toastManager.add({
          type:
            kind === "completion"
              ? "success"
              : item.kind === "question" || item.kind === "approval"
                ? "info"
                : "error",
          title: item.title,
          description: item.label,
          data: { hideCopyButton: true },
          actionProps: {
            children:
              item.kind === "question"
                ? "Answer question"
                : item.kind === "approval"
                  ? "Review tool call"
                  : "Open conversation",
            onClick: () => {
              toastManager.close(id);
              open();
            },
          },
        });
      } else if (
        hasDesktopNotifications(mode) &&
        !foreground &&
        typeof Notification !== "undefined" &&
        Notification.permission === "granted"
      ) {
        try {
          const notification = new Notification(item.title, {
            body: item.label,
            tag: `meerkat:${environmentId}:${item.id}`,
            silent: true,
          });
          onNotification(environmentId, notification);
          notification.addEventListener("click", () => {
            notification.close();
            window.focus();
            open();
          });
        } catch {
          /* Notification presentation can fail independently of the durable attention item. */
        }
      }
    }
  }, [
    query.data,
    query.error,
    search.attention,
    mode,
    inApp,
    navigate,
    environmentId,
    onNotification,
  ]);
  return null;
}
