import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { EnvironmentId } from "@t3tools/contracts";

import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { toastManager } from "~/components/ui/toast";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { FileSurfaceNotice } from "./fileSurfaceChrome";
import { fileEditRecoveryStore } from "./fileEditRecoveryStore";

function CopyEdits({ contents, recovered = false }: { contents: string; recovered?: boolean }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: "unsaved file edits",
    onError: () => {
      toastManager.add({
        type: "error",
        title: "Could not copy unsaved edits",
        description: "The recovery text has been kept. Select the text and copy it manually.",
      });
    },
  });
  return (
    <>
      {contents === "" ? <span>The retained edit is an empty file.</span> : null}
      <Button
        type="button"
        variant="outline"
        size="xs"
        disabled={contents === ""}
        onClick={() => copyToClipboard(contents, undefined)}
      >
        {isCopied ? "Copied" : recovered ? "Copy recovered edits" : "Copy unsaved edits"}
      </Button>
    </>
  );
}

export function FileEditRecoveryNotice({
  environmentId,
  cwd,
  relativePath,
  saveFailed,
  contents,
  store = fileEditRecoveryStore,
}: {
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
  saveFailed: boolean;
  contents: string | undefined;
  store?: typeof fileEditRecoveryStore;
}) {
  const target = useMemo(
    () => ({ environmentId, cwd, relativePath }),
    [environmentId, cwd, relativePath],
  );
  const getSnapshot = useCallback(() => store.getSnapshot(target), [store, target]);
  const snapshot = useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    store.refresh(target);
  }, [store, target]);
  const memoryOnly = snapshot.current !== null && !snapshot.current.persisted;
  const unsavedContents = snapshot.current?.contents ?? contents;
  return (
    <>
      {(saveFailed || memoryOnly) && unsavedContents !== undefined ? (
        <FileSurfaceNotice>
          <div className="flex flex-wrap items-center gap-2">
            <span>
              {saveFailed
                ? "Changes were not saved to the file. "
                : "The file save is not yet confirmed. "}
              {snapshot.current?.persisted
                ? "A recovery copy is kept on this device."
                : "A recovery copy could not be saved on this device. Your edits are only kept in this window. Copy them before closing the window or app."}
            </span>
            <CopyEdits contents={unsavedContents} />
          </div>
        </FileSurfaceNotice>
      ) : null}
      {snapshot.readFailed ? (
        <FileSurfaceNotice>
          <div className="flex flex-wrap items-center gap-2">
            <span>Saved recovery copies could not be read. They have not been discarded.</span>
            <Button type="button" variant="outline" size="xs" onClick={() => store.refresh(target)}>
              Retry loading recovery
            </Button>
          </div>
        </FileSurfaceNotice>
      ) : null}
      {snapshot.removalFailed && snapshot.current === null ? (
        <FileSurfaceNotice>
          <div className="flex flex-wrap items-center gap-2">
            <span>A recovery copy could not be discarded. It has been kept; try again.</span>
            {!snapshot.readFailed ? (
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => store.refresh(target)}
              >
                Reload recovery copies
              </Button>
            ) : null}
          </div>
        </FileSurfaceNotice>
      ) : null}
      {snapshot.copies.map((copy) => (
        <FileSurfaceNotice key={copy.key}>
          <div className="flex flex-col gap-2">
            <span>Recovered unsaved edits. The file on disk has not been changed by recovery.</span>
            <details>
              <summary>View recovered edits</summary>
              <Textarea
                aria-label="Recovered file edits"
                value={copy.contents}
                readOnly
                size="sm"
              />
            </details>
            <div className="flex flex-wrap items-center gap-2">
              <CopyEdits contents={copy.contents} recovered />
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => store.discard(target, copy)}
              >
                Discard recovery copy
              </Button>
            </div>
          </div>
        </FileSurfaceNotice>
      ))}
    </>
  );
}
