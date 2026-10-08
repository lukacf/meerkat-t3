import { act, StrictMode, useLayoutEffect, type ChangeEvent, type KeyboardEvent } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { useCommitOnBlur } from "./useCommitOnBlur";

type Props = {
  value: string;
  onCommit: (next: string) => void | Promise<boolean>;
  normalize?: (next: string) => string;
};
let renderer: ReactTestRenderer | undefined;
let current: ReturnType<typeof useCommitOnBlur>;
let props: Props;

function Probe(input: Props) {
  const state = useCommitOnBlur(input.value, input.onCommit, input.normalize);
  useLayoutEffect(() => {
    current = state;
  });
  return null;
}
function render(input: Props) {
  props = input;
  act(() => {
    const element = (
      <StrictMode>
        <Probe {...input} />
      </StrictMode>
    );
    if (renderer) renderer.update(element);
    else renderer = create(element);
  });
}
function upstream(value: string) {
  render({ ...props, value });
}
function edit(text: string) {
  act(() => current.onFocus());
  act(() => current.onChange({ target: { value: text } } as ChangeEvent<HTMLInputElement>));
}
function blur() {
  act(() => current.onBlur());
}
function enter() {
  const preventDefault = vi.fn();
  act(() =>
    current.onKeyDown({
      key: "Enter",
      nativeEvent: {},
      preventDefault,
      target: { blur: () => current.onBlur() },
    } as unknown as KeyboardEvent<HTMLInputElement>),
  );
  expect(preventDefault).toHaveBeenCalledOnce();
}
function deferred() {
  let resolve!: (value: boolean) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<boolean>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => {
  if (renderer) act(() => renderer!.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

it("keeps synchronous callbacks and authoritative resync without committing keystrokes", () => {
  const commit = vi.fn();
  render({ value: "saved", onCommit: commit });
  edit("edited");
  expect(commit).not.toHaveBeenCalled();
  blur();
  expect(commit).toHaveBeenCalledExactlyOnceWith("edited");
  upstream("edited");
  expect(current.value).toBe("edited");
  act(() => current.onFocus());
  blur();
  expect(commit).toHaveBeenCalledOnce();
  upstream("external");
  expect(current.value).toBe("external");
});

it("does not clobber a focused edit with upstream changes", () => {
  const commit = vi.fn();
  render({ value: "saved", onCommit: commit });
  edit("edited");
  upstream("external");
  expect(current.value).toBe("edited");
  blur();
  expect(commit).toHaveBeenCalledExactlyOnceWith("edited");
});

it("retains one pending attempt across repeated focus, blur and Enter", async () => {
  const save = deferred();
  const commit = vi.fn(() => save.promise);
  render({ value: "saved", onCommit: commit });
  edit("attempt");
  blur();
  expect(current.isPending).toBe(true);
  expect(current.value).toBe("attempt");
  act(() => current.onFocus());
  blur();
  enter();
  upstream("unrelated update");
  expect(current.value).toBe("attempt");
  expect(commit).toHaveBeenCalledExactlyOnceWith("attempt");
  await act(async () => save.resolve(true));
  expect(current.isPending).toBe(false);
  expect(current.value).toBe("attempt");
  upstream("attempt");
  upstream("later authoritative value");
  expect(current.value).toBe("later authoritative value");
});

it("retries an unchanged failed draft by Enter and waits for acknowledged readback", async () => {
  const first = deferred();
  const retry = deferred();
  const commit = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise);
  render({ value: "saved", onCommit: commit });
  edit("attempt");
  blur();
  await act(async () => first.resolve(false));
  expect(current.hasFailed).toBe(true);
  expect(current.value).toBe("attempt");
  act(() => current.onFocus());
  expect(current.value).toBe("attempt");
  enter();
  expect(commit.mock.calls).toEqual([["attempt"], ["attempt"]]);
  await act(async () => retry.resolve(true));
  expect(current.hasFailed).toBe(false);
  expect(current.value).toBe("attempt");
  act(() => current.onFocus());
  blur();
  expect(commit).toHaveBeenCalledTimes(2);
  upstream("attempt");
  upstream("reset");
  expect(current.value).toBe("reset");
});

it("retains rejected and synchronously thrown attempts without exposing the error", async () => {
  const save = deferred();
  const commit = vi
    .fn()
    .mockReturnValueOnce(save.promise)
    .mockImplementationOnce(() => {
      throw new Error("synthetic private detail");
    });
  render({ value: "saved", onCommit: commit });
  edit("attempt");
  blur();
  await act(async () => save.reject(new Error("synthetic private detail")));
  expect(current.hasFailed).toBe(true);
  expect(current.value).toBe("attempt");
  blur();
  expect(current.hasFailed).toBe(true);
  expect(current.isPending).toBe(false);
  expect(current.value).toBe("attempt");
  expect(commit).toHaveBeenCalledTimes(2);
});

it("normalizes canonical no-op edits without a request or waiting for an update", () => {
  const commit = vi.fn();
  render({ value: "Name", onCommit: commit, normalize: (text) => text.trim() });
  edit(" Name ");
  blur();
  expect(commit).not.toHaveBeenCalled();
  expect(current.value).toBe("Name");
  expect(current.hasUncommittedChanges).toBe(false);
});

it("commits the normalized value and releases its draft only on matching readback", async () => {
  const save = deferred();
  const commit = vi.fn(() => save.promise);
  render({ value: "old", onCommit: commit, normalize: (text) => text.trim() });
  edit(" Name ");
  blur();
  expect(commit).toHaveBeenCalledExactlyOnceWith("Name");
  await act(async () => save.resolve(true));
  expect(current.value).toBe(" Name ");
  upstream("Name");
  expect(current.value).toBe("Name");
  upstream("Reset");
  expect(current.value).toBe("Reset");
});

it("preserves a newer draft when an older attempt fails and retries only the newer edit", async () => {
  const first = deferred();
  const retry = deferred();
  const commit = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise);
  render({ value: "saved", onCommit: commit });
  edit("first");
  blur();
  edit("newer");
  blur();
  await act(async () => first.resolve(false));
  expect(current.value).toBe("newer");
  expect(commit).toHaveBeenCalledOnce();
  enter();
  expect(commit.mock.calls).toEqual([["first"], ["newer"]]);
  await act(async () => retry.resolve(true));
  upstream("newer");
  expect(current.value).toBe("newer");
});

it("preserves a newer draft through older success and its upstream update", async () => {
  const save = deferred();
  const commit = vi.fn(() => save.promise);
  render({ value: "saved", onCommit: commit });
  edit("first");
  blur();
  edit("newer");
  blur();
  await act(async () => save.resolve(true));
  upstream("first");
  expect(current.value).toBe("newer");
  expect(current.hasUncommittedChanges).toBe(true);
  expect(commit).toHaveBeenCalledOnce();
});

it("saves a newer revert even while the prior acknowledged value has not arrived", async () => {
  const first = deferred();
  const second = deferred();
  const commit = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  render({ value: "original", onCommit: commit });
  edit("first");
  blur();
  edit("original");
  blur();
  await act(async () => first.resolve(true));
  blur();
  expect(commit.mock.calls).toEqual([["first"], ["original"]]);
  await act(async () => second.resolve(true));
  upstream("first");
  expect(current.value).toBe("original");
  upstream("original");
  upstream("later");
  expect(current.value).toBe("later");
});

it("accepts a matching upstream update arriving before the acknowledgement", async () => {
  const save = deferred();
  render({ value: "saved", onCommit: () => save.promise });
  edit("attempt");
  blur();
  upstream("attempt");
  await act(async () => save.resolve(true));
  upstream("later");
  expect(current.value).toBe("later");
});

it("does not replay or transfer a pending completion after unmount", async () => {
  const save = deferred();
  const commit = vi.fn(() => save.promise);
  render({ value: "saved", onCommit: commit });
  edit("attempt");
  blur();
  act(() => renderer!.unmount());
  renderer = undefined;
  const nextCommit = vi.fn();
  render({ value: "other field", onCommit: nextCommit });
  await act(async () => save.resolve(false));
  expect(current.value).toBe("other field");
  expect(current.hasFailed).toBe(false);
  expect(commit).toHaveBeenCalledOnce();
  expect(nextCommit).not.toHaveBeenCalled();
});
