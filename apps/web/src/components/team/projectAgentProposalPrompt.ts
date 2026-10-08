/** The repository study publishes a validated tool result in its own conversation. */
export const PROJECT_AGENT_PROPOSAL_PROMPT = [
  "Study the actual repository before deciding: its architecture, main subsystems, ownership boundaries, and development workflows.",
  "This is read-only discovery: do not modify files, contact external services, or run deployed systems.",
  "Propose 3 to 6 non-overlapping, long-lived project agents that would materially help develop this repository.",
  "Finish with one successful ui_project_agent_proposal call. If validation rejects a call, correct the errors and retry. The native proposal panel is the deliverable: do not return the proposal as Markdown or prose.",
  "Each tool item needs a stable kebab-case id and role, a short human label, a concrete focus, a repo-grounded charter of 2-3 concise sentences, and 1-6 ownership_paths containing only exact repo-relative paths you inspected and confirmed exist. These paths scope the agent's immediate read-only domain study, so every proposed agent must have at least one.",
  "Mark only the smallest effective default team as recommended. Never use reserved roles such as ingress, thread, thread-agent, user, assistant, or system.",
  "After the tool succeeds, reply with one short sentence telling me the proposal is ready to review. Do not repeat the agent list.",
].join("\n");
