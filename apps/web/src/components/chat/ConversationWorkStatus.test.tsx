import { TurnId } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ConversationWorkStatus } from "./ConversationWorkStatus";

type Props = Parameters<typeof ConversationWorkStatus>[0];
const turn = (state: NonNullable<Props["latestTurn"]>["state"], id = "turn-1") => ({
  turnId: TurnId.make(id),
  state,
});

let renderer: ReactTestRenderer | undefined;
let props: Props;
let transcript = "Earlier message";
let elapsed = "1s";

async function render(change: Partial<Props> = {}) {
  props = { ...props, ...change };
  await act(() => {
    const content = (
      <>
        <ConversationWorkStatus {...props} />
        <p>{transcript}</p>
        <span>{elapsed}</span>
      </>
    );
    if (renderer) renderer.update(content);
    else renderer = create(content);
  });
}

function region() {
  return renderer!.root.findByProps({ role: "status" });
}

function content() {
  const child = region().children[0];
  if (!child || typeof child === "string") throw new Error("Missing announcement content");
  return child;
}

function message() {
  return content().children.join("");
}

beforeEach(() => {
  props = { scopeKey: "env-1:thread-1", enabled: true, latestTurn: null, isWorking: false };
  transcript = "Earlier message";
  elapsed = "1s";
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  if (renderer) await act(() => renderer!.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("ordinary conversation work announcements", () => {
  it.each(["completed", "error", "interrupted"] as const)(
    "opens historical %s work silently",
    async (state) => {
      await render({ latestTurn: turn(state) });
      expect(message()).toBe("");
      await render({ latestTurn: { ...turn(state) } });
      expect(message()).toBe("");
    },
  );

  it("announces a completed turn in the same persistent region", async () => {
    await render();
    const persistentRegion = region();
    await render({ latestTurn: turn("running"), isWorking: true });
    expect(message()).toBe("Working");
    await render({ latestTurn: turn("completed"), isWorking: false });
    expect(message()).toBe("Response complete");
    expect(region()).toBe(persistentRegion);
  });

  it("does not change the announcement for streamed text, ticks, or equivalent snapshots", async () => {
    await render();
    await render({ latestTurn: turn("running"), isWorking: true });
    const persistentRegion = region();
    transcript = "Partial response";
    elapsed = "2s";
    await render({ latestTurn: { ...turn("running") } });
    expect(message()).toBe("Working");
    expect(region()).toBe(persistentRegion);
    await render({ latestTurn: turn("completed"), isWorking: false });
    transcript = "Final response";
    elapsed = "3s";
    await render({ latestTurn: { ...turn("completed") } });
    expect(message()).toBe("Response complete");
    expect(region()).toBe(persistentRegion);
  });

  it.each([
    ["error", "Response failed"],
    ["interrupted", "Response interrupted"],
  ] as const)(
    "announces the actual %s outcome of work already running on open",
    async (state, expected) => {
      await render({ latestTurn: turn("running"), isWorking: true });
      expect(message()).toBe("");
      await render({ latestTurn: turn(state), isWorking: false });
      expect(message()).toBe(expected);
    },
  );

  it.each([
    ["completed", "Response complete"],
    ["error", "Response failed"],
    ["interrupted", "Response interrupted"],
  ] as const)(
    "keeps Working during native peer work, then announces the %s outcome",
    async (state, expected) => {
      await render();
      await render({ latestTurn: turn("running"), isWorking: true });
      await render({ latestTurn: turn(state), isWorking: true });
      expect(message()).toBe("Working");
      await render({ isWorking: false });
      expect(message()).toBe(expected);
    },
  );

  it("does not reuse an old successful turn when independent peer work becomes idle", async () => {
    await render({ latestTurn: turn("completed") });
    await render({ isWorking: true });
    expect(message()).toBe("Working");
    await render({ isWorking: false });
    expect(message()).toBe("");
  });

  it("does not infer a successful response from a local dispatch becoming idle", async () => {
    await render();
    await render({ isWorking: true });
    expect(message()).toBe("Working");
    await render({ isWorking: false });
    expect(message()).toBe("");
  });

  it("announces a newly observed fast turn even when its running snapshot was skipped", async () => {
    await render({ latestTurn: turn("completed", "old-turn") });
    await render({ latestTurn: turn("error", "new-turn") });
    expect(message()).toBe("Response failed");
  });

  it("replaces identical outcome text only for a distinct fast turn, not a repeated snapshot", async () => {
    await render({ latestTurn: turn("running"), isWorking: true });
    await render({ latestTurn: turn("completed"), isWorking: false });
    const persistentRegion = region();
    const previousContent = content();
    await render({ latestTurn: turn("completed", "new-turn") });
    expect(message()).toBe("Response complete");
    expect(region()).toBe(persistentRegion);
    expect(content()).not.toBe(previousContent);
    const newTurnContent = content();
    await render({ latestTurn: { ...turn("completed", "new-turn") } });
    expect(content()).toBe(newTurnContent);
    expect(message()).toBe("Response complete");
  });

  it.each(["env-2:thread-1", "env-1:thread-2"])(
    "does not carry an outcome into %s, even with the same native turn id",
    async (scopeKey) => {
      await render({ latestTurn: turn("running"), isWorking: true });
      await render({ latestTurn: turn("completed"), isWorking: false });
      expect(message()).toBe("Response complete");
      const persistentRegion = region();
      await render({ scopeKey, latestTurn: turn("completed") });
      expect(message()).toBe("");
      expect(region()).toBe(persistentRegion);
      await render({ latestTurn: turn("running", "new-turn"), isWorking: true });
      await render({ latestTurn: turn("completed", "new-turn"), isWorking: false });
      expect(message()).toBe("Response complete");
    },
  );

  it("forgets a pending outcome while inactive or unavailable and does not replay it on return", async () => {
    await render({ latestTurn: turn("running"), isWorking: true });
    await render({ latestTurn: turn("completed"), isWorking: true });
    expect(message()).toBe("Working");
    await render({ enabled: false, isWorking: false });
    expect(message()).toBe("");
    await render({ enabled: true });
    expect(message()).toBe("");
    await render({ latestTurn: turn("running", "new-turn"), isWorking: true });
    await render({ latestTurn: turn("interrupted", "new-turn"), isWorking: false });
    expect(message()).toBe("Response interrupted");
  });

  it("baselines the first loaded snapshot instead of announcing it as new work", async () => {
    await render({ enabled: false });
    await render({ enabled: true, latestTurn: turn("completed") });
    expect(message()).toBe("");
  });

  it("uses the current terminal state when peer work settles, not an earlier success", async () => {
    await render({ latestTurn: turn("running"), isWorking: true });
    await render({ latestTurn: turn("completed") });
    await render({ latestTurn: turn("error") });
    expect(message()).toBe("Working");
    await render({ isWorking: false });
    expect(message()).toBe("Response failed");
  });
});
