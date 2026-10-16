import type {
  EnvironmentId,
  MeerkatAuthScope,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { ProviderAccountsPanel } from "../settings/ProviderAccountsPanel";

export function MeerkatProviderControls(props: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  instanceId: ProviderInstanceId;
  threadTarget?: MeerkatAuthScope["threadTarget"];
}) {
  return <ProviderAccountsPanel {...props} compact />;
}
