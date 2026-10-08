import type { EnvironmentId, GitIdentityResult } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useEffect, useId, useRef, useState } from "react";
import { gitEnvironment } from "../state/git";
import { useAtomCommand } from "../state/use-atom-command";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";

type Target = { environmentId: EnvironmentId; cwd: string };
type Continuation = () => void | Promise<void>;
type AuthorSetup = {
  key: string;
  target: Target;
  identity: GitIdentityResult | null;
  error: string | null;
  continueAction?: Continuation;
};

export function useGitAuthorSetup({
  environmentId,
  cwd,
  serverLabel,
  enabled,
  contextKey,
  onActionError,
}: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  serverLabel: string;
  enabled: boolean;
  contextKey: string;
  onActionError: (cause: unknown) => void;
}) {
  const read = useAtomQueryRunner(gitEnvironment.identity, { reportFailure: false, refresh: true });
  const update = useAtomCommand(gitEnvironment.updateIdentity, { reportFailure: false });
  const [setup, setSetup] = useState<AuthorSetup | null>(null);
  const [pending, setPending] = useState(false);
  const key = JSON.stringify([environmentId, cwd, enabled, contextKey]);
  const currentKey = useRef(key);
  currentKey.current = key;
  const request = useRef(0);
  const busy = useRef(false);
  useEffect(() => {
    request.current += 1;
    busy.current = false;
    setPending(false);
    setSetup(null);
    return () => {
      request.current += 1;
    };
  }, [key]);

  function close() {
    request.current += 1;
    busy.current = false;
    setPending(false);
    setSetup(null);
  }
  async function continueOnce(action: Continuation) {
    // Author setup succeeded. An action failure must not restore its consumed continuation.
    setSetup(null);
    try {
      await action();
    } catch (cause) {
      onActionError(cause);
    }
  }
  async function inspect(continueAction?: Continuation) {
    if (!enabled) {
      await continueAction?.();
      return;
    }
    if (!environmentId || !cwd || busy.current) return;
    const target = { environmentId, cwd };
    const serial = ++request.current;
    const active = () => serial === request.current && currentKey.current === key;
    busy.current = true;
    setPending(true);
    try {
      const result = await read({ environmentId, input: { cwd } });
      if (!active()) return;
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      if (result.value.ready && continueAction) {
        await continueOnce(continueAction);
      } else {
        setSetup({
          key,
          target,
          identity: result.value,
          error: null,
          ...(continueAction ? { continueAction } : {}),
        });
      }
    } catch (cause) {
      if (active())
        setSetup({
          key,
          target,
          identity: null,
          error: cause instanceof Error ? cause.message : "Could not check the commit author.",
          ...(continueAction ? { continueAction } : {}),
        });
    } finally {
      if (active()) {
        busy.current = false;
        setPending(false);
      }
    }
  }
  async function save(name: string, email: string) {
    if (!setup || setup.key !== key || busy.current) return;
    const selected = setup;
    const serial = ++request.current;
    const active = () => serial === request.current && currentKey.current === selected.key;
    busy.current = true;
    setPending(true);
    try {
      const result = await update({
        environmentId: selected.target.environmentId,
        input: { cwd: selected.target.cwd, name: name.trim(), email: email.trim() },
      });
      if (!active()) return;
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      if (!result.value.ready) {
        setSetup({
          ...selected,
          identity: result.value,
          error:
            "Git still cannot resolve a commit author. Check the repository and environment configuration, then try again.",
        });
        return;
      }
      setSetup(null);
      if (selected.continueAction) await continueOnce(selected.continueAction);
    } catch (cause) {
      if (active())
        setSetup({
          ...selected,
          error:
            cause instanceof Error ? cause.message : "Could not save the commit author. Try again.",
        });
    } finally {
      if (active()) {
        busy.current = false;
        setPending(false);
      }
    }
  }
  const visible = setup?.key === key ? setup : null;
  return {
    pending,
    open: () => inspect(),
    runAfterAuthor: inspect,
    dialog: visible ? (
      <GitAuthorDialog
        setup={visible}
        serverLabel={serverLabel}
        pending={pending}
        onClose={close}
        onRetry={() => void inspect(visible.continueAction)}
        onSave={save}
      />
    ) : null,
  };
}

function GitAuthorDialog({
  setup,
  serverLabel,
  pending,
  onClose,
  onRetry,
  onSave,
}: {
  setup: AuthorSetup;
  serverLabel: string;
  pending: boolean;
  onClose: () => void;
  onRetry: () => void;
  onSave: (name: string, email: string) => Promise<void>;
}) {
  const formId = useId();
  const [name, setName] = useState(setup.identity?.effective.name ?? "");
  const [email, setEmail] = useState(setup.identity?.effective.email ?? "");
  useEffect(() => {
    if (setup.identity) {
      setName(setup.identity.effective.name ?? "");
      setEmail(setup.identity.effective.email ?? "");
    }
  }, [setup.identity]);
  const repository = setup.identity?.repositoryRoot;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Commit author</DialogTitle>
          <DialogDescription>
            Git uses this name and email in commit history. This is separate from GitHub sign-in.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <p className="break-all text-sm text-muted-foreground">
            {serverLabel}: {setup.target.cwd}
          </p>
          {setup.error ? (
            <p role="alert" className="text-sm text-destructive">
              {setup.error}
            </p>
          ) : null}
          {repository ? (
            <form
              id={formId}
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (!pending && name.trim() && email.trim()) void onSave(name, email);
              }}
            >
              <label className="block space-y-1 text-sm">
                Name
                <Input
                  value={name}
                  autoFocus
                  required
                  disabled={pending}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <label className="block space-y-1 text-sm">
                Email
                <Input
                  value={email}
                  required
                  disabled={pending}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>
              <p className="text-xs text-muted-foreground">
                Saved only for this repository. Your computer default stays unchanged. A
                GitHub-provided private commit email is supported.
              </p>
              {setup.continueAction ? (
                <p className="text-xs text-muted-foreground">
                  Save to continue your requested commit with the same message and selected files.
                </p>
              ) : null}
            </form>
          ) : (
            <p className="text-sm text-muted-foreground">
              {setup.identity
                ? "Initialize Git in this folder before configuring its commit author."
                : "Check the repository's Git configuration before continuing."}
            </p>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          {repository ? (
            <Button type="submit" form={formId} disabled={pending || !name.trim() || !email.trim()}>
              {pending
                ? "Saving..."
                : setup.continueAction
                  ? "Save and continue"
                  : "Save for this repository"}
            </Button>
          ) : (
            <Button disabled={pending} onClick={onRetry}>
              {pending ? "Checking..." : "Check again"}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
