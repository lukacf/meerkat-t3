import start from "../../../../../docs/user/getting-started.md?raw";
import install from "../../../../../docs/user/install.md?raw";
import accounts from "../../../../../docs/user/accounts.md?raw";
import agents from "../../../../../docs/user/agents.md?raw";
import shared from "../../../../../docs/user/shared-specialists.md?raw";
import permissions from "../../../../../docs/user/permission-modes.md?raw";
import recovery from "../../../../../docs/user/troubleshooting.md?raw";
import updates from "../../../../../docs/user/updating.md?raw";
import privacy from "../../../../../docs/user/telemetry.md?raw";
import licenses from "../../../../../docs/user/open-source-licenses.md?raw";

export const GUIDE_TOPICS = [
  { id: "start", label: "Start with your project", file: "getting-started.md", text: start },
  { id: "install", label: "Install the prototype", file: "install.md", text: install },
  { id: "accounts", label: "Providers and accounts", file: "accounts.md", text: accounts },
  { id: "agents", label: "Project specialists", file: "agents.md", text: agents },
  { id: "shared", label: "Shared specialists", file: "shared-specialists.md", text: shared },
  { id: "permissions", label: "Permissions", file: "permission-modes.md", text: permissions },
  { id: "recovery", label: "Recovery and help", file: "troubleshooting.md", text: recovery },
  { id: "updates", label: "Updates", file: "updating.md", text: updates },
  { id: "privacy", label: "Data and privacy", file: "telemetry.md", text: privacy },
  {
    id: "licenses",
    label: "Open source licenses",
    file: "open-source-licenses.md",
    text: licenses,
  },
] as const;

export type GuideTopic = (typeof GUIDE_TOPICS)[number]["id"];

export function resolveGuideTopic(value: unknown): GuideTopic {
  return GUIDE_TOPICS.find((topic) => topic.id === value)?.id ?? "start";
}

export function resolveGuideLink(href: string | undefined) {
  if (!href) return null;
  const [file, hash] = href.split("#", 2);
  const topic = GUIDE_TOPICS.find((entry) => entry.file === file);
  return topic ? { topic: topic.id, hash: hash ?? "" } : null;
}

export function guideHeadingId(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, "")
    .replace(/ +/g, "-");
}
