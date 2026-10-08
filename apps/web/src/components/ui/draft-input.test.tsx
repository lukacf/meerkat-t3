import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { DraftInput, type DraftInputProps } from "./draft-input";

let renderer: ReactTestRenderer | undefined;
let props: DraftInputProps;
function render(input: DraftInputProps) {
  props = input;
  act(() => {
    const element = <DraftInput nativeInput aria-label="Instance label" {...input} />;
    if (renderer) renderer.update(element);
    else renderer = create(element);
  });
}
const field = () => renderer!.root.findByType("input");
const status = () => renderer!.root.findByProps({ role: "status" });
function edit(text: string) {
  act(() => field().props.onFocus());
  act(() => field().props.onChange({ target: { value: text } }));
}
function blur() {
  act(() => field().props.onBlur());
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

it("announces pending and failed saves, preserves the described field and retries exact text", async () => {
  const first = deferred();
  const retry = deferred();
  const commit = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise);
  render({ value: "saved", onCommit: commit, "aria-describedby": "field-help" });
  edit("attempt");
  blur();
  expect(field().props["aria-busy"]).toBe(true);
  expect(status().children).toEqual(["Saving..."]);
  expect(field().props["aria-describedby"].split(" ")).toEqual(["field-help", status().props.id]);
  await act(async () => first.reject(new Error("synthetic private detail")));
  expect(field().props.value).toBe("attempt");
  expect(field().props["aria-invalid"]).toBe(true);
  expect(field().props["aria-busy"]).not.toBe(true);
  expect(status().children).toEqual(["Could not save. Press Enter or leave this field to retry."]);
  act(() => field().props.onFocus());
  const blurInput = vi.fn(() => field().props.onBlur());
  act(() =>
    field().props.onKeyDown({
      key: "Enter",
      nativeEvent: {},
      preventDefault: vi.fn(),
      target: { blur: blurInput },
    }),
  );
  expect(blurInput).toHaveBeenCalledOnce();
  expect(commit.mock.calls).toEqual([["attempt"], ["attempt"]]);
  await act(async () => retry.resolve(true));
  expect(field().props.value).toBe("attempt");
  expect(field().props["aria-invalid"]).not.toBe(true);
  expect(status().children).toEqual([]);
  render({ ...props, value: "attempt" });
  render({ ...props, value: "external" });
  expect(field().props.value).toBe("external");
});

it("does not submit IME Enter and does not duplicate a pending Enter/blur", async () => {
  const save = deferred();
  const commit = vi.fn(() => save.promise);
  render({ value: "saved", onCommit: commit });
  edit("attempt");
  const blurInput = vi.fn(() => field().props.onBlur());
  const preventDefault = vi.fn();
  for (const event of [{ nativeEvent: { isComposing: true } }, { nativeEvent: {}, keyCode: 229 }]) {
    act(() =>
      field().props.onKeyDown({
        key: "Enter",
        target: { blur: blurInput },
        preventDefault,
        ...event,
      }),
    );
  }
  expect(blurInput).not.toHaveBeenCalled();
  expect(preventDefault).not.toHaveBeenCalled();
  blur();
  act(() => field().props.onFocus());
  act(() =>
    field().props.onKeyDown({
      key: "Enter",
      nativeEvent: {},
      target: { blur: blurInput },
      preventDefault,
    }),
  );
  expect(commit).toHaveBeenCalledExactlyOnceWith("attempt");
  await act(async () => save.resolve(false));
});

it("keeps newer unsubmitted text visible with an actionable status after the old save succeeds", async () => {
  const save = deferred();
  const commit = vi.fn(() => save.promise);
  render({ value: "saved", onCommit: commit });
  edit("first");
  blur();
  edit("newer");
  blur();
  await act(async () => save.resolve(true));
  render({ ...props, value: "first" });
  expect(field().props.value).toBe("newer");
  expect(status().children).toEqual(["Unsaved changes. Press Enter or leave this field to save."]);
  expect(commit).toHaveBeenCalledOnce();
});
