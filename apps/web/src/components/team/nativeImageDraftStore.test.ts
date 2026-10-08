import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type MeerkatImageRef,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { createNativeImageDraftStore, nativeImageDraftStorageKey } from "./nativeImageDraftStore";

function memoryStorage() {
  const entries = new Map<string, string>();
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
    removeItem: (key: string) => {
      entries.delete(key);
    },
  };
}
const scope = {
  environmentId: EnvironmentId.make("environment"),
  projectId: ProjectId.make("project"),
  instanceId: ProviderInstanceId.make("meerkat"),
  agentRef: "old-incarnation",
};
const image: MeerkatImageRef = {
  type: "image",
  source: "blob",
  media_type: "image/png",
  blob_id: `sha256:${"a".repeat(64)}`,
};

describe("native image draft write recovery", () => {
  it("retains a failed upload write through a later removal and successful retry", () => {
    const durable = memoryStorage();
    let fail = false;
    const storage = {
      ...durable,
      setItem: (key: string, value: string) => {
        if (fail) throw new Error("quota");
        durable.setItem(key, value);
      },
    };
    const store = createNativeImageDraftStore("target", "legacy", storage);
    expect(store.getState().updateImages(() => [image])).toBe(true);
    const added = { ...image, blob_id: `sha256:${"b".repeat(64)}` };
    fail = true;
    expect(store.getState().updateImages((current) => [...current, added])).toBe(false);
    expect(store.getState().images).toEqual([image, added]);
    expect(store.getState().readFailed).toBe(false);
    expect(store.getState().readForSend()).toEqual([image, added]);
    fail = false;
    expect(
      store
        .getState()
        .updateImages((current) => current.filter((item) => item.blob_id !== image.blob_id)),
    ).toBe(true);
    expect(createNativeImageDraftStore("target", "legacy", durable).getState().images).toEqual([
      added,
    ]);
  });
});

describe("durable native image drafts", () => {
  it("migrates only references and restores them for the stable target after a cold restart", () => {
    const durable = memoryStorage();
    const session = memoryStorage();
    const legacyKey = `meerkat-image-draft:${JSON.stringify(scope)}`;
    session.setItem(legacyKey, JSON.stringify([image]));
    const key = nativeImageDraftStorageKey(scope, "stable-agent");
    const migrated = createNativeImageDraftStore(key, legacyKey, durable, session);
    expect(migrated.getState().images).toEqual([image]);
    expect(migrated.getState().persistenceError).toBeNull();
    expect(session.getItem(legacyKey)).toBeNull();
    expect(JSON.parse(durable.getItem(key)!)).toEqual([image]);

    const nextScope = { ...scope, agentRef: "new-incarnation" };
    const nextKey = nativeImageDraftStorageKey(nextScope, "stable-agent");
    expect(nextKey).toBe(key);
    expect(
      createNativeImageDraftStore(nextKey, "unused", durable, memoryStorage()).getState().images,
    ).toEqual([image]);
    expect(nativeImageDraftStorageKey(scope, "other-agent")).not.toBe(key);
    expect(
      nativeImageDraftStorageKey(
        { ...scope, environmentId: EnvironmentId.make("other") },
        "stable-agent",
      ),
    ).not.toBe(key);
    expect(
      nativeImageDraftStorageKey({ ...scope, projectId: ProjectId.make("other") }, "stable-agent"),
    ).not.toBe(key);
    expect(
      nativeImageDraftStorageKey(
        { ...scope, instanceId: ProviderInstanceId.make("other") },
        "stable-agent",
      ),
    ).not.toBe(key);
  });

  it("does not resurrect cleared images from a leftover session copy", () => {
    const durable = memoryStorage();
    const session = memoryStorage();
    session.setItem("legacy", JSON.stringify([image]));
    const staleSession = {
      ...session,
      removeItem: () => {
        throw new Error("read only");
      },
    };
    const store = createNativeImageDraftStore("durable", "legacy", durable, staleSession);
    store.getState().updateImages(() => []);
    expect(
      createNativeImageDraftStore("durable", "legacy", durable, staleSession).getState().images,
    ).toEqual([]);
  });

  it("keeps the visible refs and legacy copy with an explicit error when storage fails", () => {
    const session = memoryStorage();
    session.setItem("legacy", JSON.stringify([image]));
    const broken = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    };
    const store = createNativeImageDraftStore("durable", "legacy", broken, session);
    expect(store.getState().images).toEqual([image]);
    expect(store.getState().persistenceError).toContain("could not be saved");
    expect(session.getItem("legacy")).not.toBeNull();
    store
      .getState()
      .updateImages((current) => [...current, { ...image, blob_id: `sha256:${"b".repeat(64)}` }]);
    expect(store.getState().images).toHaveLength(2);
    expect(store.getState().persistenceError).toContain("could not be saved");
  });

  it("a late upload adds to the latest stored draft instead of restoring a removed image", () => {
    const durable = memoryStorage();
    const firstView = createNativeImageDraftStore("target", "legacy", durable);
    firstView.getState().updateImages(() => [image]);
    const reopenedView = createNativeImageDraftStore("target", "legacy", durable);
    reopenedView.getState().updateImages(() => []);
    const uploaded = { ...image, blob_id: `sha256:${"b".repeat(64)}` };
    firstView.getState().updateImages((current) => [...current, uploaded]);
    expect(createNativeImageDraftStore("target", "legacy", durable).getState().images).toEqual([
      uploaded,
    ]);
  });
  it("preserves an unreadable saved draft rather than replacing its references", () => {
    const durable = memoryStorage();
    durable.setItem("target", "{broken");
    const store = createNativeImageDraftStore("target", "legacy", durable);
    store.getState().updateImages(() => [image]);
    expect(store.getState().persistenceError).toContain("could not be read");
    expect(durable.getItem("target")).toBe("{broken");
    expect(store.getState().retryRead()).toBe(false);
    expect(store.getState().readForSend()).toBeNull();
    expect(store.getState().images).toEqual([]);
    expect(durable.getItem("target")).toBe("{broken");
  });

  it("requires explicit recovery after a failed initial read, then returns the exact saved refs", () => {
    const durable = memoryStorage();
    durable.setItem("target", JSON.stringify([image]));
    let fail = true;
    const store = createNativeImageDraftStore("target", "legacy", {
      ...durable,
      getItem: (key) => {
        if (fail) throw new Error("unavailable");
        return durable.getItem(key);
      },
    });
    fail = false;
    expect(store.getState().readFailed).toBe(true);
    expect(store.getState().readForSend()).toBeNull();
    expect(store.getState().updateImages(() => [])).toBe(false);
    expect(durable.getItem("target")).toBe(JSON.stringify([image]));
    expect(store.getState().retryRead()).toBe(true);
    expect(store.getState().readForSend()).toEqual([image]);
  });

  it("does not treat unavailable storage as an empty saved draft and reacquires it on retry", () => {
    const durable = memoryStorage();
    durable.setItem("target", JSON.stringify([image]));
    let available = false;
    const store = createNativeImageDraftStore("target", "legacy", () =>
      available ? durable : undefined,
    );
    expect(store.getState().readForSend()).toBeNull();
    available = true;
    expect(store.getState().retryRead()).toBe(true);
    expect(store.getState().readForSend()).toEqual([image]);
  });

  it("catches a later read failure and restores another view's latest refs before sending", () => {
    const durable = memoryStorage();
    durable.setItem("target", JSON.stringify([image]));
    let fail = false;
    const store = createNativeImageDraftStore("target", "legacy", {
      ...durable,
      getItem: (key) => {
        if (fail) throw new Error("unavailable");
        return durable.getItem(key);
      },
    });
    fail = true;
    expect(store.getState().readForSend()).toBeNull();
    const other = { ...image, blob_id: `sha256:${"b".repeat(64)}` };
    durable.setItem("target", JSON.stringify([other]));
    fail = false;
    expect(store.getState().retryRead()).toBe(true);
    expect(store.getState().readForSend()).toEqual([other]);
  });

  it("retains an in-flight upload through unknown storage without reviving removed refs", () => {
    const durable = memoryStorage();
    durable.setItem("target", JSON.stringify([image]));
    let fail = false;
    const store = createNativeImageDraftStore("target", "legacy", {
      ...durable,
      getItem: (key) => {
        if (fail) throw new Error("unavailable");
        return durable.getItem(key);
      },
    });
    fail = true;
    expect(store.getState().readForSend()).toBeNull();
    const uploaded = { ...image, blob_id: `sha256:${"b".repeat(64)}` };
    expect(store.getState().updateImages((current) => [...current, uploaded], true)).toBe(false);
    expect(store.getState().images).toEqual([image, uploaded]);
    expect(store.getState().readForSend()).toBeNull();
    durable.setItem("target", "[]");
    fail = false;
    expect(store.getState().retryRead()).toBe(true);
    expect(store.getState().readForSend()).toEqual([uploaded]);
    expect(store.getState().persistenceError).toContain("could not be saved");
    expect(store.getState().updateImages((current) => current)).toBe(true);
    expect(durable.getItem("target")).toBe(JSON.stringify([uploaded]));
  });
});
