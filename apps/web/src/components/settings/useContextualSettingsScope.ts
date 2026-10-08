import { useLocation, useParams, useSearch } from "@tanstack/react-router";
import { useThreadShells } from "../../state/entities";
import { contextualSettingsScope } from "./contextualSettingsScope";
import { useSettingsProjectGroups } from "./useSettingsProjectGroups";
import { validateSettingsScopeSearch } from "./settingsScope";

export function useContextualSettingsScope() {
  const params = useParams({ strict: false });
  const search = useSearch({ strict: false });
  const isSettings = useLocation({
    select: (location) => /^\/settings(\/|$)/.test(location.pathname),
  });
  const scope = contextualSettingsScope({
    environmentId: params.environmentId,
    projectId: params.projectId ?? (params.agentId ? search.project : undefined),
    threadId: params.threadId,
    groups: useSettingsProjectGroups(),
    threads: useThreadShells(),
  });
  return isSettings ? validateSettingsScopeSearch(search) : scope;
}
