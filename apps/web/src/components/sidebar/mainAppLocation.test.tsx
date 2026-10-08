import type { ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const router = vi.hoisted(() => ({
  location: { pathname: "/settings/providers", href: "/settings/providers" },
  navigate: vi.fn<(options: { href: string }) => Promise<void>>(),
}));

vi.mock("@tanstack/react-router", () => ({
  useLocation: <T,>({ select }: { select: (location: typeof router.location) => T }) =>
    select(router.location),
  useNavigate: () => router.navigate,
}));

const storageKey = "t3code:last-main-app-href:v1";
const recoveryHref = "/remote-environment/recovery-thread?tab=changes#saved-message";
const accountsHref =
  "/settings/providers?environmentId=remote-environment&instanceId=meerkat&accountProject=project&accountThread=recovery-thread&accountCwd=%2Fwork%2Fcheckout";

function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    key: (index) => [...items.keys()][index] ?? null,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
    removeItem: (key) => {
      items.delete(key);
    },
    clear: () => items.clear(),
  };
}

function setLocation(href: string) {
  const url = new URL(href, "https://t3.invalid");
  router.location = { pathname: url.pathname, href };
}

let unmount: (() => Promise<void>) | undefined;
let tabStorage: Storage;

async function mount(href: string) {
  // Import a fresh helper after resetModules to model a renderer reload. React
  // and its renderer are imported together so their hook dispatcher stays shared.
  const { createElement, Fragment } = await import("react");
  const { act, create } = await import("react-test-renderer");
  const { MainAppLocationTracker, useNavigateToMainApp } = await import("./mainAppLocation");
  function Back() {
    const back = useNavigateToMainApp();
    return createElement("button", { onClick: back }, "Back");
  }
  const content = () =>
    createElement(Fragment, null, createElement(MainAppLocationTracker), createElement(Back));
  let renderer!: ReactTestRenderer;
  setLocation(href);
  await act(async () => {
    renderer = create(content());
  });
  unmount = async () => {
    await act(async () => renderer.unmount());
  };
  return {
    async visit(nextHref: string) {
      setLocation(nextHref);
      await act(async () => renderer.update(content()));
    },
    async back() {
      await act(async () => renderer.root.findByType("button").props.onClick());
    },
  };
}

async function reload(href: string) {
  await unmount?.();
  unmount = undefined;
  vi.resetModules();
  return mount(href);
}

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  tabStorage = memoryStorage();
  vi.stubGlobal("window", { sessionStorage: tabStorage });
  router.navigate.mockReset().mockResolvedValue(undefined);
});

afterEach(async () => {
  await unmount?.();
  unmount = undefined;
  vi.unstubAllGlobals();
});

describe("utility-page return navigation", () => {
  it("returns to the exact recovery conversation after two Settings reloads", async () => {
    const app = await mount(recoveryHref);
    await app.visit(accountsHref);
    expect(router.navigate).not.toHaveBeenCalled();
    await reload(accountsHref);
    const reloaded = await reload(accountsHref);
    await reloaded.back();
    expect(router.navigate).toHaveBeenCalledExactlyOnceWith({ href: recoveryHref });
  });

  it("retains the origin across utility pages and replaces it after a new workspace visit", async () => {
    const app = await mount(recoveryHref);
    await app.visit(accountsHref);
    await app.visit("/settings/general");
    await app.visit("/help?topic=accounts");
    await app.back();
    expect(router.navigate).toHaveBeenLastCalledWith({ href: recoveryHref });

    const agentHref = "/other-environment/agents/specialist?project=other-project";
    await app.visit(agentHref);
    await app.visit("/usage");
    const reloaded = await reload("/usage");
    await reloaded.back();
    expect(router.navigate).toHaveBeenLastCalledWith({ href: agentHref });
  });

  it("does not take another tab's destination or overwrite the original tab's return route", async () => {
    const firstTab = await mount(recoveryHref);
    await firstTab.visit(accountsHref);
    const firstStorage = tabStorage;

    const secondStorage = memoryStorage();
    vi.stubGlobal("window", { sessionStorage: secondStorage });
    const secondTab = await reload("/settings/general");
    await secondTab.back();
    expect(router.navigate).toHaveBeenLastCalledWith({ href: "/" });
    await secondTab.visit("/draft/second-tab-draft");
    await secondTab.visit("/help");

    vi.stubGlobal("window", { sessionStorage: firstStorage });
    const firstTabReloaded = await reload(accountsHref);
    await firstTabReloaded.back();
    expect(router.navigate).toHaveBeenLastCalledWith({ href: recoveryHref });
  });

  it.each([
    null,
    "",
    "https://example.com/thread",
    "//example.com/thread",
    "javascript:alert(1)",
    "relative/thread",
    " /environment/thread",
    "/\\example.com/thread",
    "/environment/\nthread",
    "/%2Fexample.com/thread",
    "/environment/%5Cthread",
    "/environment/%00thread",
    "/environment/%ZZ",
    "/environment/thread?invalid=%2",
    "/environment/thread#%ED%A0%80",
    "/settings/providers?accountThread=thread",
    "/%73ettings/providers",
    "/environment/../settings/providers",
    "/usage/",
    "/help#accounts",
    "/projects/project",
    "/projects",
    "/pull-requests",
  ])("falls back safely for stored non-workspace target %j", async (href) => {
    if (href !== null) tabStorage.setItem(storageKey, href);
    const app = await mount(accountsHref);
    await app.back();
    expect(router.navigate).toHaveBeenCalledExactlyOnceWith({ href: "/" });
  });

  it("prefers the current live route if storage later contains a stale destination", async () => {
    const app = await mount(recoveryHref);
    await app.visit(accountsHref);
    tabStorage.setItem(storageKey, "/draft/stale-draft");
    await app.back();
    expect(router.navigate).toHaveBeenCalledExactlyOnceWith({ href: recoveryHref });
  });

  it.each(["no-window", "getter", "read-write"] as const)(
    "keeps live Back working and cold fallback safe with unavailable storage: %s",
    async (failure) => {
      if (failure === "no-window") vi.stubGlobal("window", undefined);
      else if (failure === "getter") {
        vi.stubGlobal("window", {
          get sessionStorage() {
            throw new Error("Storage is unavailable");
          },
        });
      } else {
        vi.stubGlobal("window", {
          sessionStorage: {
            getItem: () => {
              throw new Error("Storage reads are unavailable");
            },
            setItem: () => {
              throw new Error("Storage writes are unavailable");
            },
          },
        });
      }
      const app = await mount(recoveryHref);
      await app.visit(accountsHref);
      await app.back();
      expect(router.navigate).toHaveBeenLastCalledWith({ href: recoveryHref });

      const reloaded = await reload(accountsHref);
      await reloaded.back();
      expect(router.navigate).toHaveBeenLastCalledWith({ href: "/" });
    },
  );
});
