import {
  AuthAdministrativeScopes,
  AuthSharedParticipantScopes,
  AuthSessionId,
  EnvironmentId,
  type AuthClientSession,
  type AuthPairingLink,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  scopes: [] as readonly string[],
  links: [] as AuthPairingLink[],
  clients: [] as AuthClientSession[],
  create: vi.fn(),
  list: vi.fn(),
  revoke: vi.fn(),
  listClients: vi.fn(),
  revokeClient: vi.fn(),
  copy: vi.fn(),
  storage: vi.fn(),
  commandOptions: vi.fn(),
}));
vi.mock("../../state/session", () => ({
  environmentSession: {
    createPairingCredential: "create",
    listPairingLinks: "list",
    revokePairingLink: "revoke",
    listClientSessions: "listClients",
    revokeClientSession: "revokeClient",
  },
  useEnvironmentSessionState: () => ({
    data: { authenticated: true, scopes: state.scopes },
    isPending: false,
  }),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (
    command: "create" | "list" | "revoke" | "listClients" | "revokeClient",
    options: unknown,
  ) => {
    state.commandOptions(options);
    return state[command];
  },
}));
vi.mock("../../hooks/useCopyToClipboard", () => ({
  writeTextToClipboard: (...args: unknown[]) => state.copy(...args),
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/input", () => ({ Input: "input" }));
import { SharedHostInvitations } from "./SharedHostInvitations";

const environmentId = EnvironmentId.make("shared-host");
const expiresAt = DateTime.makeUnsafe("2099-10-17T10:05:00Z");
function invitation(id = "old-invite"): AuthPairingLink {
  return {
    id,
    label: id === "old-invite" ? "Alice's Mac" : "Bob",
    subject: "one-time-token",
    scopes: AuthSharedParticipantScopes,
    createdAt: DateTime.makeUnsafe("2026-10-17T10:00:00Z"),
    expiresAt,
  };
}
function client(id = "participant"): AuthClientSession {
  return {
    sessionId: AuthSessionId.make(id),
    subject: "one-time-token",
    scopes: AuthSharedParticipantScopes,
    method: "browser-session-cookie",
    client: { label: "Alice's desktop", deviceType: "desktop", os: "macOS" },
    issuedAt: DateTime.makeUnsafe("2026-10-17T10:00:00Z"),
    expiresAt,
    lastConnectedAt: null,
    connected: true,
    current: false,
  };
}
let renderer: ReactTestRenderer | undefined;
const text = () => JSON.stringify(renderer!.toJSON());
const buttons = (label: string) =>
  renderer!.root.findAllByType("button").filter((button) => button.children.includes(label));
const render = async (id = environmentId, connected = true) => {
  await act(async () => {
    renderer = create(
      <SharedHostInvitations environmentId={id} hostLabel="Product host" connected={connected} />,
    );
  });
};
const submit = async () => {
  await act(async () => renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }));
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("localStorage", { setItem: state.storage, getItem: () => null });
  state.scopes = AuthAdministrativeScopes;
  state.links = [invitation()];
  state.clients = [];
  for (const mock of [
    state.create,
    state.list,
    state.revoke,
    state.listClients,
    state.revokeClient,
    state.copy,
    state.storage,
    state.commandOptions,
  ])
    mock.mockReset();
  state.list.mockImplementation(async () => ({ _tag: "Success", value: state.links }));
  state.listClients.mockImplementation(async () => ({ _tag: "Success", value: state.clients }));
  state.create.mockImplementation(async () => {
    state.links = [...state.links, invitation("new-invite")];
    return {
      _tag: "Success",
      value: {
        id: "new-invite",
        credential: "private-once",
        expiresAt,
        httpBaseUrl: "https://shared.example/old?unused=1#old",
      },
    };
  });
  state.revoke.mockResolvedValue({ _tag: "Success", value: { revoked: true } });
  state.revokeClient.mockResolvedValue({ _tag: "Success", value: { revoked: true } });
  state.copy.mockResolvedValue(true);
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

it("requires this host's admin permissions and a connected environment", async () => {
  state.scopes = AuthSharedParticipantScopes;
  await render();
  expect(text()).toContain("administrator connection to this host");
  expect(buttons("Create invitation")).toHaveLength(0);
  expect(state.list).not.toHaveBeenCalled();
  expect(state.create).not.toHaveBeenCalled();
  expect(state.listClients).not.toHaveBeenCalled();
  expect(state.revokeClient).not.toHaveBeenCalled();
  state.scopes = AuthAdministrativeScopes;
  await act(async () =>
    renderer!.update(
      <SharedHostInvitations
        environmentId={environmentId}
        hostLabel="Product host"
        connected={false}
      />,
    ),
  );
  expect(text()).toContain("Reconnect this host");
  expect(state.list).not.toHaveBeenCalled();
  expect(state.listClients).not.toHaveBeenCalled();
});

it("lists and revokes only participant client access on this host, preserving current and administrative sessions", async () => {
  state.clients = [
    client(),
    {
      ...client("admin"),
      scopes: AuthAdministrativeScopes,
      client: { label: "Admin desktop", deviceType: "desktop" },
    },
    {
      ...client("current"),
      current: true,
      client: { label: "Current connection", deviceType: "desktop" },
    },
  ];
  await render();
  expect(state.listClients).toHaveBeenCalledWith({ environmentId, input: {} });
  expect(text()).toContain("Alice's desktop");
  expect(text()).toContain("Connected");
  expect(text()).toContain("Access issued");
  expect(text()).not.toContain("Admin desktop");
  expect(text()).not.toContain("Current connection");
  expect(buttons("Revoke access")).toHaveLength(1);
  await act(async () => buttons("Revoke invitation")[0]!.props.onClick());
  expect(state.revokeClient).not.toHaveBeenCalled();
  expect(text()).toContain("Alice's desktop");
  await act(async () => buttons("Revoke access")[0]!.props.onClick());
  expect(state.revokeClient).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { sessionId: "participant" },
  });
  expect(text()).toContain("Client access revoked");
  expect(text()).toContain("needs a new invitation");
  expect(text()).not.toContain("Alice's desktop");
  expect(buttons("Revoke access")).toHaveLength(0);
});

it("keeps the client visible when revocation fails, without displaying private error details", async () => {
  state.clients = [client()];
  state.revokeClient.mockResolvedValueOnce({ _tag: "Failure", cause: new Error("token=private") });
  await render();
  await act(async () => buttons("Revoke access")[0]!.props.onClick());
  expect(text()).toContain("Could not revoke client access");
  expect(text()).toContain("Alice's desktop");
  expect(text()).not.toContain("token=private");
  expect(buttons("Revoke access")).toHaveLength(1);
});

it("allows revoking an existing read-only participant without exposing broader sessions", async () => {
  state.clients = [{ ...client(), scopes: ["shared:read"] }];
  await render();
  expect(buttons("Revoke access")).toHaveLength(1);
  await act(async () => buttons("Revoke access")[0]!.props.onClick());
  expect(state.revokeClient).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { sessionId: "participant" },
  });
});

it("does not resurrect revoked client access from an older refresh", async () => {
  state.clients = [client()];
  await render();
  let finish!: (value: unknown) => void;
  state.listClients.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await act(async () => buttons("Refresh access")[0]!.props.onClick());
  await act(async () => buttons("Revoke access")[0]!.props.onClick());
  await act(async () => finish({ _tag: "Success", value: state.clients }));
  expect(text()).not.toContain("Alice's desktop");
  expect(buttons("Revoke access")).toHaveLength(0);
  expect(text()).toContain("Client access revoked");
});

it("does not claim empty access lists when their initial read failed", async () => {
  state.list.mockResolvedValueOnce({ _tag: "Failure", cause: new Error("private details") });
  state.listClients.mockResolvedValueOnce({ _tag: "Failure", cause: new Error("private details") });
  await render();
  expect(text()).toContain("Could not refresh all shared access");
  expect(text()).not.toContain("No active shared specialist invitations");
  expect(text()).not.toContain("No shared participant clients");
  expect(text()).not.toContain("private details");
});

it("loads and revokes older invitation metadata after remount, without needing its credential", async () => {
  state.links.push({
    ...invitation("admin-link"),
    label: "Administrator link",
    scopes: AuthAdministrativeScopes,
  });
  await render();
  expect(state.list).toHaveBeenCalledWith({ environmentId, input: {} });
  expect(text()).toContain("Alice's Mac");
  expect(text()).toContain("Created");
  expect(text()).toContain("Expires");
  expect(text()).not.toContain("Administrator link");
  expect(buttons("Copy invitation link")).toHaveLength(0);
  await act(async () => renderer!.unmount());
  await render();
  await act(async () => buttons("Revoke invitation")[0]!.props.onClick());
  expect(state.revoke).toHaveBeenCalledWith({ environmentId, input: { id: "old-invite" } });
  expect(text()).toContain("Invitation revoked");
  expect(text()).toContain("Already connected clients keep their access");
  expect(renderer!.root.findAllByType("li")).toHaveLength(0);
});

it("creates participant-only links for the issuing host and retains secrets only for this visit", async () => {
  await render();
  await act(async () =>
    renderer!.root
      .findByProps({ "aria-label": "Invitation label" })
      .props.onChange({ target: { value: "  Bob  " } }),
  );
  await submit();
  expect(state.create).toHaveBeenCalledWith({
    environmentId,
    input: { label: "Bob", scopes: AuthSharedParticipantScopes },
  });
  expect(text()).not.toContain("private-once");
  await act(async () => buttons("Copy invitation link")[0]!.props.onClick());
  expect(state.copy).toHaveBeenCalledWith(
    "https://shared.example/pair#token=private-once",
    "shared host invitation",
  );
  await act(async () => buttons("Show link")[0]!.props.onClick());
  expect(renderer!.root.findByProps({ "aria-label": "Invitation link" }).props.value).toBe(
    "https://shared.example/pair#token=private-once",
  );
  expect(state.storage).not.toHaveBeenCalled();
  for (const [options] of state.commandOptions.mock.calls)
    expect(options).toEqual({ reportFailure: false, reportDefect: false });
  await act(async () => renderer!.unmount());
  await render();
  expect(text()).not.toContain("private-once");
  expect(buttons("Copy invitation link")).toHaveLength(0);
  expect(buttons("Revoke invitation")).toHaveLength(2);
});

it("does not display credential-bearing errors and gives a manual-copy fallback", async () => {
  await render();
  state.create.mockResolvedValueOnce({
    _tag: "Failure",
    cause: new Error("private-once http://private#token=secret"),
  });
  await submit();
  expect(text()).toContain("Could not confirm invitation creation");
  expect(text()).not.toContain("private-once");
  expect(text()).not.toContain("token=secret");
  await submit();
  state.copy.mockRejectedValueOnce(new Error("private-once"));
  await act(async () => buttons("Copy invitation link")[0]!.props.onClick());
  expect(text()).toContain("Select and copy the invitation link");
  expect(renderer!.root.findByProps({ "aria-label": "Invitation link" }).props.value).toContain(
    "#token=private-once",
  );
});

it("does not carry a delayed created secret into another host", async () => {
  let finish!: (value: unknown) => void;
  state.create.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render();
  await submit();
  await act(async () =>
    renderer!.update(
      <SharedHostInvitations
        environmentId={EnvironmentId.make("other-host")}
        hostLabel="Other host"
        connected
      />,
    ),
  );
  await act(async () =>
    finish({
      _tag: "Success",
      value: {
        id: "late",
        credential: "delayed-secret",
        expiresAt,
        httpBaseUrl: "https://first.example",
      },
    }),
  );
  expect(text()).not.toContain("delayed-secret");
  expect(buttons("Copy invitation link")).toHaveLength(0);
  expect(state.list).toHaveBeenLastCalledWith({ environmentId: "other-host", input: {} });
});

it("shows expired metadata and does not expose an expired new link", async () => {
  const expired = DateTime.makeUnsafe("2020-10-17T10:00:00Z");
  state.links = [{ ...invitation("expired"), expiresAt: expired }];
  state.create.mockResolvedValueOnce({
    _tag: "Success",
    value: {
      id: "expired",
      credential: "expired-secret",
      expiresAt: expired,
      httpBaseUrl: "http://127.0.0.1:1234",
    },
  });
  await render();
  await submit();
  expect(text()).toContain("Expired");
  expect(buttons("Copy invitation link")).toHaveLength(0);
  expect(text()).not.toContain("expired-secret");
});
