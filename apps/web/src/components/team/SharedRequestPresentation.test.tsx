import {
  EnvironmentId,
  type ConsoleFrame,
  type SharedInbox,
  type SharedSpecialistRequest,
} from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { SharedMarkdown, SharedRequestCard } from "./SharedRequestCard";
import { SharedActivityInbox } from "./SharedActivityInbox";
import { projectAgentPermissionLabel } from "./ProjectAgentPermissions";

vi.mock("../../state/sharedWorkspace", () => ({ sharedWorkspaceEnvironment: {} }));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: vi.fn() }));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/tooltip", () => ({
  Tooltip: "span",
  TooltipTrigger: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  TooltipPopup: "span",
}));
const at = "2026-10-16T12:00:00.000Z";
function request(author: string, branch: string, completed: boolean): SharedSpecialistRequest {
  const frame: ConsoleFrame = {
    id: `answer-${author}`,
    cursor: "console:4",
    dedupe_key: `answer-${author}`,
    timestamp_ms: 1000,
    runtime_key: "native",
    identity: "inventory",
    kind: "interaction_complete",
    status: "completed",
    frame_version: 1,
    source: { kind: "console_event" },
    payload: { text: `Result for ${author}` },
  };
  return {
    requestId: `ledger-${author}`,
    clientRequestId: `request-${author}`,
    nativeRequestId: `native-${author}`,
    specialistId: "inventory",
    author: { participantId: author, displayName: author, kind: "person", createdAt: at },
    context: {
      contextId: `context-${author}`,
      contextVersion: `version-${author}`,
      participantId: author,
      checkoutId: `checkout-${author}`,
      sharedProjectId: "catalog",
      source: { kind: "project_conversation" },
      objective: "Review the migration",
      revision: {
        branch,
        commit: (author === "Alice" ? "a" : "b").repeat(40),
        applicability: "branch",
      },
      paths: [],
      tags: [],
      updatedAt: at,
    },
    text: `Request from ${author}`,
    createdAt: at,
    outcome: {
      status: completed ? "completed" : "unresolved",
      receipt: null,
      completion: completed ? frame : null,
      detail: completed ? null : "Native evidence is not available yet.",
      observedAt: at,
    },
  };
}
let rendered: ReactTestRenderer | undefined;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await act(async () => rendered?.unmount());
  vi.unstubAllGlobals();
});

describe("shared request presentation", () => {
  it("keeps different participants and revisions attached to their exact result", async () => {
    await act(async () => {
      rendered = create(
        <>
          <SharedRequestCard
            request={request("Alice", "feature/inventory", false)}
            specialistLabel="Inventory"
            projectLabel="Catalog"
          />
          <SharedRequestCard
            request={request("Bob", "fix/stock", true)}
            specialistLabel="Inventory"
            projectLabel="Catalog"
          />
        </>,
      );
    });
    const rows = rendered!.root.findAllByType("article");
    const alice = JSON.stringify(
      rows[0]!
        .findAllByType("div")
        .map((node) => node.children.filter((child) => typeof child === "string")),
    );
    expect(rows[0]!.props["data-shared-request-id"]).toBe("ledger-Alice");
    const tree = JSON.stringify(rendered!.toJSON());
    expect(tree).toContain("feature/inventory");
    expect(tree).toContain("fix/stock");
    expect(tree).toContain("Outcome unresolved");
    expect(tree).toContain("Result for Bob");
    expect(tree).not.toContain("Result for Alice");
    expect(alice).not.toContain("Result for Bob");
  });

  it("does not turn an accepted receipt into completion text", async () => {
    const accepted = request("Alice", "feature/inventory", false);
    await act(async () => {
      rendered = create(
        <SharedRequestCard
          request={{ ...accepted, outcome: { ...accepted.outcome, status: "accepted" } }}
          specialistLabel="Inventory"
          projectLabel="Catalog"
        />,
      );
    });
    expect(JSON.stringify(rendered!.toJSON())).toContain("Accepted, awaiting result");
    expect(JSON.stringify(rendered!.toJSON())).not.toContain('"Completed"');
  });

  it("offers retry only for a request confirmed not sent", async () => {
    const pending = request("Alice", "feature/inventory", false);
    const retry = vi.fn();
    await act(async () => {
      rendered = create(
        <SharedRequestCard
          request={{ ...pending, outcome: { ...pending.outcome, status: "not_admitted" } }}
          specialistLabel="Inventory"
          projectLabel="Catalog"
          onRetry={retry}
        />,
      );
    });
    expect(JSON.stringify(rendered!.toJSON())).toContain("Not sent");
    expect(JSON.stringify(rendered!.toJSON())).not.toContain('"Completed"');
    await act(async () => rendered!.root.findByType("button").props.onClick());
    expect(retry).toHaveBeenCalledTimes(1);
    await act(async () =>
      rendered!.update(
        <SharedRequestCard
          request={pending}
          specialistLabel="Inventory"
          projectLabel="Catalog"
          onRetry={retry}
        />,
      ),
    );
    expect(rendered!.root.findAllByType("button")).toHaveLength(0);
  });

  it("shared markdown exposes ordinary web links without file or terminal navigation", async () => {
    await act(async () => {
      rendered = create(
        <SharedMarkdown
          text={
            "[source](https://example.test/review) [file](file:///host/private.txt) [command](vscode://open) ![image](https://example.test/private.png)"
          }
        />,
      );
    });
    expect(rendered!.root.findAllByType("a").map((link) => link.props.href)).toEqual([
      "https://example.test/review",
    ]);
    expect(rendered!.root.findAllByType("img")).toHaveLength(0);
  });

  it("acknowledges the exact displayed product batch, with no task-completion claim", async () => {
    const acknowledge = vi.fn();
    const inbox: SharedInbox = {
      recipientId: "alice",
      batchId: "sealed-batch",
      events: [],
      hasMore: true,
    };
    await act(async () => {
      rendered = create(
        <SharedActivityInbox
          environmentId={EnvironmentId.make("shared-host")}
          inbox={inbox}
          snapshot={null}
          busy={false}
          offline={false}
          error={null}
          onRefresh={() => {}}
          onAcknowledge={acknowledge}
        />,
      );
    });
    const button = rendered!.root
      .findAllByType("button")
      .find((node) => node.children.includes("Mark these updates read"))!;
    await act(async () => button.props.onClick());
    expect(acknowledge).toHaveBeenCalledExactlyOnceWith("sealed-batch");
    expect(JSON.stringify(rendered!.toJSON())).toContain(
      "Task delivery and completion are shown with each request.",
    );
    await act(async () =>
      rendered!.update(
        <SharedActivityInbox
          environmentId={EnvironmentId.make("shared-host")}
          inbox={inbox}
          snapshot={null}
          busy={false}
          offline={true}
          error={null}
          onRefresh={() => {}}
          onAcknowledge={acknowledge}
        />,
      ),
    );
    expect(rendered!.root.findAllByType("button").every((node) => node.props.disabled)).toBe(true);
  });

  it("does not call a never-loaded offline inbox empty", async () => {
    await act(async () => {
      rendered = create(
        <SharedActivityInbox
          environmentId={EnvironmentId.make("shared-host")}
          inbox={null}
          snapshot={null}
          busy={false}
          offline={true}
          error={null}
          onRefresh={() => {}}
          onAcknowledge={() => {}}
        />,
      );
    });
    expect(JSON.stringify(rendered!.toJSON())).toContain("Host offline");
    expect(JSON.stringify(rendered!.toJSON())).not.toContain("No unread product updates.");
  });

  it("distinguishes native repository protection from blanket read-only mode", () => {
    expect(projectAgentPermissionLabel("repository-read-only")).toBe("Repository read-only");
    expect(projectAgentPermissionLabel("read-only")).toBe("Read-only");
  });
});
