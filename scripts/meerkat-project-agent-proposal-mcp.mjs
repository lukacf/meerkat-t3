#!/usr/bin/env node
// Pure app-owned validation: this tool does not create agents, inspect files, or call a model.
import * as NodeReadline from "node:readline";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";
import { normalizeProjectAgentProposal } from "./meerkat-project-agent-proposal-contract.mjs";

export const proposalTool = {
  name: "ui_project_agent_proposal",
  title: "Publish project-agent proposal",
  description:
    "Publish a repo-grounded proposal for native review after inspecting the repository. Propose 3-6 non-overlapping durable specialists, exact inspected ownership paths, and the smallest effective recommended team. Correct validation errors and retry the tool; do not substitute prose.",
  inputSchema: JSON.parse(
    await NodeFSP.readFile(
      new URL("./meerkat-project-agent-proposal-schema.json", import.meta.url),
      "utf8",
    ),
  ),
};
export function validateProposalTool(input) {
  const proposal = normalizeProjectAgentProposal(input);
  return proposal
    ? {
        content: [
          {
            type: "text",
            text: `Published ${proposal.agents.length} project-agent proposals for native review.`,
          },
        ],
        structuredContent: proposal,
        isError: false,
      }
    : {
        content: [
          {
            type: "text",
            text: "Project-agent proposal rejected: payload must satisfy the complete contract, including unique roles and labels, at least one recommended agent, and valid ownership paths.",
          },
        ],
        isError: true,
      };
}
export function handleProposalRpc(request) {
  if (request.id === undefined) return null;
  const ok = (result) => ({ jsonrpc: "2.0", id: request.id, result });
  if (request.method === "initialize")
    return ok({
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "meerkat-project-agent-proposal", version: "1.0.0" },
    });
  if (request.method === "ping") return ok({});
  if (request.method === "tools/list") return ok({ tools: [proposalTool] });
  if (request.method === "tools/call" && request.params?.name === proposalTool.name)
    return ok(validateProposalTool(request.params.arguments));
  return {
    jsonrpc: "2.0",
    id: request.id,
    error: { code: -32601, message: "Method or tool not found" },
  };
}
async function isEntrypoint() {
  if (import.meta.main !== undefined) return import.meta.main;
  if (!process.argv[1]) return false;
  if (import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) return true;
  try {
    // Packaged paths can include directory symlinks, such as macOS /tmp.
    // Node resolves the module URL but keeps the original path in argv.
    return import.meta.url === NodeURL.pathToFileURL(await NodeFSP.realpath(process.argv[1])).href;
  } catch {
    return false;
  }
}
if (await isEntrypoint()) {
  const lines = NodeReadline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    try {
      const result = handleProposalRpc(JSON.parse(line));
      if (result) process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`,
      );
    }
  }
}
