// Adapted from the original Meerkat App project-agent proposal contract.
const PROJECT_AGENT_PROPOSAL_TOOL_NAME = "ui_project_agent_proposal";
const RESERVED_ROLES = new Set([
  "ingress",
  "thread",
  "thread-agent",
  "user",
  "assistant",
  "system",
]);
const PROPOSAL_KEYS = new Set(["title", "summary", "agents"]);
const AGENT_KEYS = new Set([
  "id",
  "label",
  "role",
  "focus",
  "charter",
  "recommended",
  "ownership_paths",
]);

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseRecord(value) {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function hasOnlyKeys(record, allowed) {
  return Object.keys(record).every((key) => allowed.has(key));
}

function normalizedText(value, minLength, maxLength) {
  if (typeof value !== "string") {
    return null;
  }
  const text = value.replace(/\s+/gu, " ").trim();
  return text.length >= minLength && text.length <= maxLength ? text : null;
}

function isProjectAgentProposalToolName(value) {
  const name = String(value || "")
    .trim()
    .toLowerCase();
  return (
    name === PROJECT_AGENT_PROPOSAL_TOOL_NAME ||
    name.endsWith(`.${PROJECT_AGENT_PROPOSAL_TOOL_NAME}`) ||
    name.endsWith(`__${PROJECT_AGENT_PROPOSAL_TOOL_NAME}`) ||
    name.endsWith(`/${PROJECT_AGENT_PROPOSAL_TOOL_NAME}`)
  );
}

function normalizeOwnershipPath(value) {
  if (typeof value !== "string") {
    return null;
  }
  const path = value
    .trim()
    .replace(/\/{2,}/gu, "/")
    .replace(/\/$/u, "");
  if (
    !path ||
    path.length > 120 ||
    path.startsWith("/") ||
    /^[a-z]:/iu.test(path) ||
    // eslint-disable-next-line no-control-regex, no-useless-escape -- Reject glob syntax and control bytes, matching the original app contract.
    /[?*\[\]{}\\\u0000-\u001f]/u.test(path)
  ) {
    return null;
  }
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return null;
  }
  return path;
}

function normalizeAgent(value) {
  const record = parseRecord(value);
  if (!record || !hasOnlyKeys(record, AGENT_KEYS)) {
    return null;
  }
  const id = normalizedText(record.id, 2, 48);
  const label = normalizedText(record.label, 2, 48);
  const role = normalizedText(record.role, 2, 48);
  const focus = normalizedText(record.focus, 3, 180);
  const charter = normalizedText(record.charter, 20, 800);
  if (
    !id ||
    !label ||
    !role ||
    !focus ||
    !charter ||
    (record.recommended !== true && record.recommended !== false) ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id) ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(role) ||
    RESERVED_ROLES.has(role)
  ) {
    return null;
  }
  const rawOwnershipPaths = record.ownership_paths;
  if (
    !Array.isArray(rawOwnershipPaths) ||
    rawOwnershipPaths.length < 1 ||
    rawOwnershipPaths.length > 6
  ) {
    return null;
  }
  const ownershipPaths = rawOwnershipPaths.map(normalizeOwnershipPath);
  if (
    ownershipPaths.some((entry) => !entry) ||
    new Set(ownershipPaths).size !== ownershipPaths.length
  ) {
    return null;
  }
  return {
    id,
    label,
    role,
    focus,
    charter,
    recommended: record.recommended,
    ownershipPaths,
  };
}

function normalizeProjectAgentProposal(value, options = {}) {
  const record = parseRecord(value);
  if (!record || !hasOnlyKeys(record, PROPOSAL_KEYS)) {
    return null;
  }
  const title = normalizedText(record.title, 3, 100);
  const summary = record.summary == null ? null : normalizedText(record.summary, 0, 320);
  if (!title || (summary == null && record.summary != null)) {
    return null;
  }
  if (!Array.isArray(record.agents) || record.agents.length < 3 || record.agents.length > 6) {
    return null;
  }
  const agents = record.agents.map(normalizeAgent);
  if (agents.some((agent) => !agent)) {
    return null;
  }
  if (
    new Set(agents.map((agent) => agent.id)).size !== agents.length ||
    new Set(agents.map((agent) => agent.role)).size !== agents.length ||
    new Set(agents.map((agent) => agent.label.toLowerCase())).size !== agents.length ||
    !agents.some((agent) => agent.recommended)
  ) {
    return null;
  }
  return {
    proposalId: String(options.proposalId || "proposal"),
    title,
    summary: summary || null,
    agents,
  };
}

export {
  PROJECT_AGENT_PROPOSAL_TOOL_NAME,
  isProjectAgentProposalToolName,
  normalizeOwnershipPath,
  normalizeProjectAgentProposal,
};
