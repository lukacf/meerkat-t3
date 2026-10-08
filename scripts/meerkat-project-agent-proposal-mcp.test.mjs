import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  handleProposalRpc,
  proposalTool,
  validateProposalTool,
} from "./meerkat-project-agent-proposal-mcp.mjs";

const proposal = () => ({
  title: "Repository domains",
  agents: ["core", "quality", "docs"].map((role) => ({
    id: role,
    label: role,
    role,
    focus: `Study ${role} internals`,
    charter: `Maintain the ${role} domain boundaries and verified invariants.`,
    recommended: role === "core",
    ownership_paths: [role],
  })),
});
NodeTest.describe("pure project-agent proposal MCP", () => {
  NodeTest.it(
    "serves its bundled tool through direct and symlinked paths with spaces",
    async () => {
      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "meerkat-proposal-entry-"));
      try {
        const bundled = NodePath.join(root, "Meerkat T3 (Prototype).app", "runtime");
        const linked = NodePath.join(root, "linked application");
        await NodeFSP.mkdir(bundled, { recursive: true });
        for (const name of [
          "meerkat-project-agent-proposal-mcp.mjs",
          "meerkat-project-agent-proposal-contract.mjs",
          "meerkat-project-agent-proposal-schema.json",
        ]) {
          await NodeFSP.copyFile(new URL(name, import.meta.url), NodePath.join(bundled, name));
        }
        await NodeFSP.symlink(bundled, linked, "junction");
        for (const directory of [bundled, linked]) {
          const child = NodeChildProcess.spawnSync(
            process.execPath,
            [NodePath.join(directory, "meerkat-project-agent-proposal-mcp.mjs")],
            {
              input: [
                JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
                JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
                JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
                "",
              ].join("\n"),
              encoding: "utf8",
              timeout: 5_000,
              maxBuffer: 128 * 1024,
            },
          );
          NodeAssert.equal(child.error, undefined);
          NodeAssert.equal(child.status, 0, child.stderr);
          const replies = child.stdout.trim().split("\n").filter(Boolean).map(JSON.parse);
          NodeAssert.equal(
            replies.length,
            2,
            "the entrypoint must respond instead of silently exiting",
          );
          NodeAssert.equal(replies[0].result.serverInfo.name, "meerkat-project-agent-proposal");
          NodeAssert.deepEqual(
            replies[1].result.tools.map((tool) => tool.name),
            ["ui_project_agent_proposal"],
          );
        }
      } finally {
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    },
  );
  NodeTest.it("exposes exactly the validation tool and returns a typed structured proposal", () => {
    const listed = handleProposalRpc({ id: 1, method: "tools/list" });
    NodeAssert.deepEqual(
      listed.result.tools.map((tool) => tool.name),
      ["ui_project_agent_proposal"],
    );
    const result = handleProposalRpc({
      id: 2,
      method: "tools/call",
      params: { name: proposalTool.name, arguments: proposal() },
    }).result;
    NodeAssert.equal(result.isError, false);
    NodeAssert.deepEqual(result.structuredContent.agents[0].ownershipPaths, ["core"]);
    NodeAssert.equal(handleProposalRpc({ method: "notifications/initialized" }), null);
  });
  NodeTest.it(
    "rejects malformed and authority-smuggling payloads without publishing structuredContent",
    () => {
      for (const mutate of [
        (value) => {
          value.agents = value.agents.slice(0, 2);
        },
        (value) => {
          value.agents[0].ownership_paths = ["../outside"];
        },
        (value) => {
          value.agents[0].role = "ingress";
        },
        (value) => {
          value.agents[1].role = "core";
        },
        (value) => {
          value.agents[1].label = "CORE";
        },
        (value) => {
          value.agents.forEach((agent) => {
            agent.recommended = false;
          });
        },
        (value) => {
          value.agents[0].instructions = "Injected";
        },
        (value) => {
          value.projectId = "other-project";
        },
      ]) {
        const payload = proposal();
        mutate(payload);
        const result = validateProposalTool(payload);
        NodeAssert.equal(result.isError, true);
        NodeAssert.equal(result.structuredContent, undefined);
      }
    },
  );
});
