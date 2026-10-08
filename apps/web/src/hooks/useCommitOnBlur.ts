import { type ChangeEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";

type Draft = { readonly text: string };
type Attempt = {
  readonly draft: Draft;
  readonly value: string;
  readonly upstreamRevision: number;
};
type DraftState = {
  readonly upstreamValue: string;
  readonly upstreamRevision: number;
  readonly draft: Draft | null;
  readonly focused: boolean;
  readonly pending: boolean;
  readonly failed: boolean;
  readonly acknowledged: Attempt | null;
};

function reconcile(state: DraftState): DraftState {
  const saved = state.acknowledged;
  if (
    !saved ||
    state.upstreamRevision <= saved.upstreamRevision ||
    state.upstreamValue !== saved.value ||
    (state.focused && state.draft === saved.draft)
  ) {
    return state;
  }
  return {
    ...state,
    draft: state.draft === saved.draft ? null : state.draft,
    acknowledged: null,
  };
}

/**
 * Commit only on blur or Enter. Async callers acknowledge with true; false or
 * rejection keeps the draft for retry. Acknowledged text stays visible until
 * its matching upstream update arrives. Normalize using the caller's existing
 * persistence rules so canonical no-op edits need no request or update.
 * Synchronous void callbacks retain the original immediate resync behavior.
 */
export function useCommitOnBlur(
  value: string,
  onCommit: (next: string) => void | Promise<boolean>,
  normalize: (next: string) => string = (next) => next,
) {
  const [state, setState] = useState<DraftState>({
    upstreamValue: value,
    upstreamRevision: 0,
    draft: null,
    focused: false,
    pending: false,
    failed: false,
    acknowledged: null,
  });
  const inFlight = useRef<Attempt | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  if (state.upstreamValue !== value) {
    setState(
      reconcile({
        ...state,
        upstreamValue: value,
        upstreamRevision: state.upstreamRevision + 1,
      }),
    );
  }

  const commit = () => {
    if (inFlight.current || !state.draft) return;
    const draft = state.draft;
    // Focus/blur must not resend an acknowledged draft while its readback lags.
    if (state.acknowledged?.draft === draft) return;
    const next = normalize(draft.text);
    if (next === normalize(value) && !state.acknowledged) {
      setState((current) => ({
        ...current,
        draft: current.draft === draft ? null : current.draft,
        failed: false,
      }));
      return;
    }
    const attempt = { draft, value: next, upstreamRevision: state.upstreamRevision };
    inFlight.current = attempt;
    setState((current) => ({ ...current, pending: true, failed: false }));
    const finish = (success: boolean, synchronous = false) => {
      if (inFlight.current !== attempt) return;
      inFlight.current = null;
      if (!mounted.current) return;
      setState((current) =>
        reconcile({
          ...current,
          pending: false,
          failed: !success,
          draft: synchronous && current.draft === attempt.draft ? null : current.draft,
          acknowledged: success ? (synchronous ? null : attempt) : current.acknowledged,
        }),
      );
    };
    try {
      const result = onCommit(next);
      if (result === undefined) finish(true, true);
      else
        void result.then(
          (success) => finish(success),
          () => finish(false),
        );
    } catch {
      finish(false);
    }
  };

  return {
    value: state.draft?.text ?? value,
    isPending: state.pending,
    hasFailed: state.failed,
    hasUncommittedChanges:
      !state.focused && state.draft !== null && state.acknowledged?.draft !== state.draft,
    onChange: (event: ChangeEvent<HTMLInputElement>) => {
      const text = event.target.value;
      setState((current) => ({ ...current, draft: { text }, failed: false }));
    },
    onFocus: () => {
      setState((current) => ({
        ...current,
        focused: true,
        draft: current.draft ?? { text: value },
      }));
    },
    onBlur: () => {
      setState((current) => reconcile({ ...current, focused: false }));
      commit();
    },
    onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === "Enter") {
        event.preventDefault();
        (event.target as HTMLInputElement).blur();
      }
    },
  };
}
