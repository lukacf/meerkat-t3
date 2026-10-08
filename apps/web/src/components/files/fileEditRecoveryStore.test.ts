import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { createFileEditRecoveryStore } from "./fileEditRecoveryStore";

function memoryStorage() {
  const values = new Map<string, string>();
  const faults = {
    read: false,
    write: false,
    remove: false,
    ignoreWrite: false,
    ignoreRemove: false,
  };
  const storage = {
    get length() {
      return values.size;
    },
    key(index: number) {
      return [...values.keys()][index] ?? null;
    },
    getItem(key: string) {
      if (faults.read) throw new Error("Synthetic storage read failure");
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      if (faults.write) throw new Error("Synthetic storage quota failure");
      if (!faults.ignoreWrite) values.set(key, value);
    },
    removeItem(key: string) {
      if (faults.remove) throw new Error("Synthetic storage removal failure");
      if (!faults.ignoreRemove) values.delete(key);
    },
  };
  return { values, faults, storage };
}

const target = {
  environmentId: EnvironmentId.make("environment-a"),
  cwd: "/work/a",
  relativePath: "file.txt",
};

describe("file edit recovery storage", () => {
  it.each(["unfinished text\n", ""])(
    "recovers an unconfirmed copy across store recreation: %j",
    (contents) => {
      const { storage } = memoryStorage();
      const first = createFileEditRecoveryStore(() => storage, "window-a");
      first.capture(target, contents);
      expect(first.getSnapshot(target)).toMatchObject({
        current: { contents, persisted: true },
        copies: [],
      });
      const reopened = createFileEditRecoveryStore(() => storage, "window-b");
      expect(reopened.getSnapshot(target)).toMatchObject({ current: null, copies: [{ contents }] });
    },
  );

  it("isolates environment, checkout and relative path even when names match", () => {
    const { storage } = memoryStorage();
    const first = createFileEditRecoveryStore(() => storage, "window-a");
    first.capture(target, "only here");
    const reopened = createFileEditRecoveryStore(() => storage, "window-b");
    for (const other of [
      { ...target, environmentId: EnvironmentId.make("environment-b") },
      { ...target, cwd: "/work/b" },
      { ...target, relativePath: "other/file.txt" },
    ])
      expect(reopened.getSnapshot(other).copies).toEqual([]);
    expect(reopened.getSnapshot(target).copies).toHaveLength(1);
  });

  it("retires only the newest confirmed generation through X/Y/X overlap", () => {
    const { storage, values } = memoryStorage();
    const store = createFileEditRecoveryStore(() => storage, "window-a");
    const x1 = store.capture(target, "X");
    const y = store.capture(target, "Y");
    const x2 = store.capture(target, "X");
    store.confirm(x1);
    store.confirm(y);
    expect(values.size).toBe(1);
    expect(
      createFileEditRecoveryStore(() => storage, "reopen").getSnapshot(target).copies[0]?.contents,
    ).toBe("X");
    store.confirm(x2);
    expect(values.size).toBe(0);
    expect(store.getSnapshot(target)).toMatchObject({ current: null, copies: [] });
  });

  it("a late discard from another window cannot remove the writer's next generation", () => {
    const { storage } = memoryStorage();
    const writer = createFileEditRecoveryStore(() => storage, "writer");
    writer.capture(target, "old");
    const reader = createFileEditRecoveryStore(() => storage, "reader");
    const stale = reader.getSnapshot(target).copies[0]!;
    writer.capture(target, "new");
    expect(reader.discard(target, stale)).toBe(true);
    reader.refresh(target);
    expect(reader.getSnapshot(target).copies.map((copy) => copy.contents)).toEqual(["new"]);
  });

  it("confirmation never clears another window's unsaved record", () => {
    const { storage } = memoryStorage();
    const a = createFileEditRecoveryStore(() => storage, "a");
    const b = createFileEditRecoveryStore(() => storage, "b");
    const saved = a.capture(target, "A");
    b.capture(target, "B");
    a.confirm(saved);
    expect(
      createFileEditRecoveryStore(() => storage, "reopen")
        .getSnapshot(target)
        .copies.map((copy) => copy.contents),
    ).toEqual(["B"]);
  });

  it("keeps the last stored copy when the next edit exceeds quota", () => {
    const { storage, faults } = memoryStorage();
    const writer = createFileEditRecoveryStore(() => storage, "writer");
    writer.capture(target, "stored");
    faults.write = true;
    const newest = writer.capture(target, "new in-memory text");
    expect(writer.getSnapshot(target).current).toEqual({
      contents: "new in-memory text",
      persisted: false,
    });
    expect(
      createFileEditRecoveryStore(() => storage, "reopen")
        .getSnapshot(target)
        .copies.map((copy) => copy.contents),
    ).toEqual(["stored"]);
    writer.confirm(newest);
    expect(
      createFileEditRecoveryStore(() => storage, "after-save").getSnapshot(target).copies,
    ).toEqual([]);
  });

  it("unavailable storage or writer identity never crashes normal editing", () => {
    const missing = createFileEditRecoveryStore(() => undefined, "a");
    const write = missing.capture(target, "keep in memory");
    expect(missing.getSnapshot(target)).toMatchObject({
      readFailed: true,
      current: { persisted: false },
    });
    expect(() => missing.confirm(write)).not.toThrow();
    const { storage, values } = memoryStorage();
    const noIdentity = createFileEditRecoveryStore(() => storage, null);
    noIdentity.capture(target, "not persisted");
    expect(noIdentity.getSnapshot(target).current?.persisted).toBe(false);
    expect(values.size).toBe(0);
  });

  it("detects silent write rejection without claiming a recovery copy", () => {
    const { storage, faults } = memoryStorage();
    faults.ignoreWrite = true;
    const store = createFileEditRecoveryStore(() => storage, "a");
    store.capture(target, "text");
    expect(store.getSnapshot(target).current?.persisted).toBe(false);
  });

  it("does not retain cleanup work or report discard failure for rejected edits", () => {
    const { storage, faults, values } = memoryStorage();
    faults.write = true;
    const store = createFileEditRecoveryStore(() => storage, "a");
    store.capture(target, "first rejected edit");
    store.capture(target, "second rejected edit");
    const last = store.capture(target, "latest rejected edit");
    expect(values.size).toBe(0);
    faults.read = true;
    store.confirm(last);
    expect(store.getSnapshot(target)).toMatchObject({
      current: null,
      copies: [],
      removalFailed: false,
    });
  });

  it("preserves unread records and recovers them on explicit retry", () => {
    const { storage, faults, values } = memoryStorage();
    createFileEditRecoveryStore(() => storage, "a").capture(target, "old recovery");
    const before = [...values];
    faults.read = true;
    const store = createFileEditRecoveryStore(() => storage, "b");
    expect(store.getSnapshot(target).readFailed).toBe(true);
    expect([...values]).toEqual(before);
    faults.read = false;
    store.refresh(target);
    expect(store.getSnapshot(target)).toMatchObject({
      readFailed: false,
      copies: [{ contents: "old recovery" }],
    });
  });

  it.each(["broken JSON", '{"version":2,"contents":"unknown format"}'])(
    "recovers a later valid edit after reload without discarding malformed bytes: %s",
    (malformed) => {
      const { storage, values } = memoryStorage();
      const write = createFileEditRecoveryStore(() => storage, "a").capture(target, "old");
      values.set(write.key, malformed);
      const store = createFileEditRecoveryStore(() => storage, "b");
      expect(store.getSnapshot(target).readFailed).toBe(true);
      store.capture(target, "new");
      expect(values.get(write.key)).toBe(malformed);
      expect(store.getSnapshot(target).current?.persisted).toBe(true);
      const reopened = createFileEditRecoveryStore(() => storage, "c");
      expect(reopened.getSnapshot(target)).toMatchObject({
        readFailed: true,
        current: null,
        copies: [{ contents: "new" }],
      });
      expect(reopened.discard(target, reopened.getSnapshot(target).copies[0]!)).toBe(true);
      expect([...values]).toEqual([[write.key, malformed]]);
    },
  );

  it.each(["remove", "ignoreRemove"] as const)(
    "failed %s keeps the copy visible until a successful explicit discard",
    (fault) => {
      const { storage, faults } = memoryStorage();
      createFileEditRecoveryStore(() => storage, "a").capture(target, "recover me");
      const store = createFileEditRecoveryStore(() => storage, "b");
      const copy = store.getSnapshot(target).copies[0]!;
      faults[fault] = true;
      expect(store.discard(target, copy)).toBe(false);
      expect(store.getSnapshot(target)).toMatchObject({
        removalFailed: true,
        copies: [{ contents: "recover me" }],
      });
      faults[fault] = false;
      expect(store.discard(target, copy)).toBe(true);
      expect(store.getSnapshot(target)).toMatchObject({ removalFailed: false, copies: [] });
    },
  );

  it("does not discard a record through another file's target", () => {
    const { storage, values } = memoryStorage();
    createFileEditRecoveryStore(() => storage, "a").capture(target, "keep");
    const store = createFileEditRecoveryStore(() => storage, "b");
    const copy = store.getSnapshot(target).copies[0]!;
    expect(store.discard({ ...target, cwd: "/another-checkout" }, copy)).toBe(false);
    expect(values.size).toBe(1);
  });

  it("reports failed post-save cleanup as a retained copy, not as an unconfirmed file write", () => {
    const { storage, faults } = memoryStorage();
    const store = createFileEditRecoveryStore(() => storage, "a");
    const write = store.capture(target, "saved text");
    faults.remove = true;
    store.confirm(write);
    expect(store.getSnapshot(target)).toMatchObject({
      current: null,
      removalFailed: true,
      copies: [{ contents: "saved text" }],
    });
    faults.remove = false;
    expect(store.discard(target, store.getSnapshot(target).copies[0]!)).toBe(true);
  });
});
