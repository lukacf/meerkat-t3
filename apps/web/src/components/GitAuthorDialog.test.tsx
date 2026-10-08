import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, type GitIdentityResult } from "@t3tools/contracts";

const state = vi.hoisted(() => ({
  read: vi.fn(),
  update: vi.fn(),
  commit: vi.fn(),
  actionError: vi.fn(),
}));
vi.mock("../state/git", () => ({
  gitEnvironment: { identity: "identity", updateIdentity: "update" },
}));
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => state.read }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => state.update }));
vi.mock("./ui/button", () => ({ Button: "button" }));
vi.mock("./ui/input", () => ({ Input: "input" }));
vi.mock("./ui/dialog", () => ({
  Dialog: "dialog",
  DialogDescription: "p",
  DialogFooter: "footer",
  DialogHeader: "header",
  DialogPanel: "section",
  DialogPopup: "article",
  DialogTitle: "h2",
}));
import { useGitAuthorSetup } from "./GitAuthorDialog";
import { snapshotCommitFilePaths } from "./GitActionsControl.logic";

const missing: GitIdentityResult = {
  repositoryRoot: "/remote/repo",
  ready: false,
  effective: { name: null, email: null },
  local: { name: null, email: null },
  global: { name: null, email: null },
};
const configured: GitIdentityResult = {
  ...missing,
  ready: true,
  effective: { name: "Robin", email: "robin@example.test" },
  local: { name: "Robin", email: "robin@example.test" },
};
const request = {
  action: "commit_push_pr",
  commitMessage: "Keep my exact message",
  filePaths: ["selected.ts"],
};
function Harness({
  environment = "remote",
  cwd = "/remote/repo",
  context = "thread-a",
  enabled = true,
  currentFiles = ["selected.ts"],
  selectedPaths,
}: {
  environment?: string;
  cwd?: string;
  context?: string;
  enabled?: boolean;
  currentFiles?: string[];
  selectedPaths?: string[];
} = {}) {
  const setup = useGitAuthorSetup({
    environmentId: EnvironmentId.make(environment),
    cwd,
    serverLabel: "Remote build server",
    enabled,
    contextKey: context,
    onActionError: state.actionError,
  });
  return (
    <>
      <button
        id="commit"
        disabled={setup.pending}
        onClick={() => {
          const filePaths = snapshotCommitFilePaths(
            selectedPaths,
            currentFiles.map((path) => ({ path })),
          );
          if (filePaths) {
            const selectedRequest = { ...request, filePaths };
            return setup.runAfterAuthor(() => state.commit(selectedRequest));
          }
        }}
      >
        Commit
      </button>
      <button id="configure" disabled={setup.pending} onClick={setup.open}>
        Configure author
      </button>
      {setup.dialog}
    </>
  );
}
let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.read.mockReset().mockResolvedValue({ _tag: "Success", value: missing });
  state.update.mockReset().mockResolvedValue({ _tag: "Success", value: configured });
  state.commit.mockReset();
  state.actionError.mockReset();
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});
async function mount(props = {}) {
  await act(async () => {
    renderer = create(<Harness {...props} />);
  });
}
async function click(id: string) {
  await act(async () => renderer!.root.findByProps({ id }).props.onClick());
}
async function fillAuthor() {
  const inputs = renderer!.root.findAllByType("input");
  await act(async () => {
    inputs[0]!.props.onChange({ target: { value: "Robin" } });
    inputs[1]!.props.onChange({ target: { value: "robin@example.test" } });
  });
}
async function save() {
  await act(async () => renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }));
}

it("holds the exact commit request until the remote repository author is saved", async () => {
  await mount();
  await click("commit");
  expect(state.commit).not.toHaveBeenCalled();
  expect(state.read).toHaveBeenCalledWith({
    environmentId: "remote",
    input: { cwd: "/remote/repo" },
  });
  await fillAuthor();
  await save();
  expect(state.update).toHaveBeenCalledWith({
    environmentId: "remote",
    input: { cwd: "/remote/repo", name: "Robin", email: "robin@example.test" },
  });
  expect(state.commit).toHaveBeenCalledExactlyOnceWith(request);
  expect(renderer!.root.findAllByType("dialog")).toHaveLength(0);
});

it("keeps entered identity and the requested action after a failed save", async () => {
  state.update.mockRejectedValueOnce(new Error("Permission denied"));
  await mount();
  await click("commit");
  await fillAuthor();
  await save();
  expect(state.commit).not.toHaveBeenCalled();
  expect(renderer!.root.findByProps({ role: "alert" }).children).toContain("Permission denied");
  expect(renderer!.root.findAllByType("input").map((input) => input.props.value)).toEqual([
    "Robin",
    "robin@example.test",
  ]);
  await save();
  expect(state.commit).toHaveBeenCalledExactlyOnceWith(request);
});

it("keeps the original file selection when new changes appear during author setup", async () => {
  await mount();
  await click("commit");
  await act(async () =>
    renderer!.update(<Harness currentFiles={["selected.ts", "late-secret.ts"]} />),
  );
  await fillAuthor();
  await save();
  expect(state.commit).toHaveBeenCalledExactlyOnceWith(request);
});

it.each([false, true])(
  "does not restore a consumed action after rejection (author already configured: %s)",
  async (alreadyConfigured) => {
    const failure = new Error("The remote disconnected after accepting the action");
    state.commit.mockRejectedValueOnce(failure);
    if (alreadyConfigured) state.read.mockResolvedValue({ _tag: "Success", value: configured });
    await mount();
    await click("commit");
    if (!alreadyConfigured) {
      await fillAuthor();
      await save();
    }
    expect(state.commit).toHaveBeenCalledTimes(1);
    expect(state.actionError).toHaveBeenCalledExactlyOnceWith(failure);
    expect(renderer!.root.findAllByType("dialog")).toHaveLength(0);
    state.read.mockResolvedValue({ _tag: "Success", value: configured });
    await click("configure");
    await save();
    expect(state.commit).toHaveBeenCalledTimes(1);
  },
);

it("does not continue if Git still cannot resolve the saved author", async () => {
  state.update.mockResolvedValueOnce({ _tag: "Success", value: missing });
  await mount();
  await click("commit");
  await fillAuthor();
  await save();
  expect(state.commit).not.toHaveBeenCalled();
  expect(renderer!.root.findByProps({ role: "alert" }).children.join("")).toContain(
    "still cannot resolve",
  );
});

it("rejects a late author lookup after switching to another thread on the same checkout", async () => {
  let resolve!: (value: unknown) => void;
  state.read.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  await mount();
  let checking: Promise<void>;
  act(() => {
    checking = renderer!.root.findByProps({ id: "commit" }).props.onClick();
  });
  await act(async () => renderer!.update(<Harness context="thread-b" />));
  await act(async () => {
    resolve({ _tag: "Success", value: configured });
    await checking;
  });
  expect(state.commit).not.toHaveBeenCalled();
  expect(renderer!.root.findAllByType("dialog")).toHaveLength(0);
});

it("does not run a saved action in another environment when the author save finishes late", async () => {
  let resolve!: (value: unknown) => void;
  state.update.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  await mount();
  await click("commit");
  await fillAuthor();
  act(() => {
    renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} });
  });
  await act(async () => renderer!.update(<Harness environment="other" cwd="/other/repo" />));
  await act(async () => {
    resolve({ _tag: "Success", value: configured });
  });
  expect(state.update.mock.calls[0]![0].environmentId).toBe("remote");
  expect(state.commit).not.toHaveBeenCalled();
});

it("preserves configured authors and older servers without the identity capability", async () => {
  state.read.mockResolvedValue({ _tag: "Success", value: configured });
  await mount();
  await click("commit");
  expect(state.commit).toHaveBeenCalledTimes(1);
  expect(state.update).not.toHaveBeenCalled();
  await act(async () => renderer!.update(<Harness enabled={false} />));
  await click("commit");
  expect(state.read).toHaveBeenCalledTimes(1);
  expect(state.commit).toHaveBeenCalledTimes(2);
});

it("can update a repository author after onboarding without starting an action", async () => {
  state.read.mockResolvedValue({ _tag: "Success", value: configured });
  await mount();
  await click("configure");
  expect(renderer!.root.findAllByType("input").map((input) => input.props.value)).toEqual([
    "Robin",
    "robin@example.test",
  ]);
  await save();
  expect(state.update).toHaveBeenCalledTimes(1);
  expect(state.commit).not.toHaveBeenCalled();
});
