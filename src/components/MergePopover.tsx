import { useId, useLayoutEffect, useState } from "react";
import type { KeyboardEvent, RefObject } from "react";
import { LoaderCircle } from "lucide-react";
import type { PullRequest } from "../domain/pullRequest";
import { counted } from "../domain/pullRequestDetail";
import {
  commitTexts,
  mergeChoices,
  mergeLabel,
  remoteDelete,
} from "../domain/pullRequestMerge";
import type { LocalDelete, MergeMethod } from "../domain/pullRequestMerge";
import type { useMerge } from "../shell/useMerge";
import { useModalDialog } from "./Dialog";
import { sentNothing } from "./sentNothing";

const WIDTH = 368;
/** The space it keeps from the window's edges and from the merge box. */
const EDGE = 16;
const GAP = 8;
/** Room for the header, a method and the buttons. */
const LEAST_HEIGHT = 200;

/** Above the merge box, at the inspector's right edge, and never above the
 * window: it scrolls inside when the room above the box is short. */
function useAbove(anchor: RefObject<HTMLElement | null>) {
  const [at, setAt] = useState<{
    bottom: number;
    right: number;
    maxHeight: number;
  } | null>(null);
  useLayoutEffect(() => {
    const place = () => {
      const box = anchor.current?.getBoundingClientRect();
      if (!box) return;
      const { innerHeight, innerWidth } = window;
      const maxHeight = Math.max(
        box.top - GAP - EDGE,
        Math.min(LEAST_HEIGHT, innerHeight - 2 * EDGE),
      );
      setAt({
        bottom: Math.min(
          Math.max(EDGE, innerHeight - box.top + GAP),
          innerHeight - EDGE - maxHeight,
        ),
        right: Math.max(EDGE, innerWidth - box.right + EDGE),
        maxHeight,
      });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchor]);
  return at;
}

export function MergePopover({
  anchor,
  pull,
  method: first,
  anyway,
  last,
  local,
  onMerge,
  onClose,
}: {
  anchor: RefObject<HTMLElement | null>;
  pull: PullRequest;
  method: MergeMethod;
  anyway: boolean;
  last: MergeMethod | null;
  local: LocalDelete;
  onMerge: ReturnType<typeof useMerge>["merge"];
  /** `merged` once the merge is on its way. */
  onClose: (merged: boolean) => void;
}) {
  const id = useId();
  const { ref, close, onCancel } = useModalDialog(() => onClose(false));
  const at = useAbove(anchor);
  // The head this popover shows. GitHub merges only while it is still the head.
  const [expectedHead] = useState(pull.head.oid);
  const [method, setMethod] = useState(first);
  const [texts, setTexts] = useState(() => commitTexts(pull, first));
  const [edited, setEdited] = useState(false);
  const remote = remoteDelete(pull);
  const [deleteRemote, setDeleteRemote] = useState(remote.kind === "github");
  const [deleteLocal, setDeleteLocal] = useState(false);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const { methods } = mergeChoices(pull, last);
  const shown = texts && commitTexts(pull, method) !== null ? texts : null;

  function pick(next: MergeMethod) {
    setMethod(next);
    setFailure(null);
    if (!edited) setTexts(commitTexts(pull, next));
  }

  function edit(change: Partial<{ headline: string; body: string }>) {
    setEdited(true);
    setFailure(null);
    setTexts((was) => ({ headline: "", body: "", ...was, ...change }));
  }

  async function confirm() {
    if (sending) return;
    if (pull.head.oid !== expectedHead)
      return setFailure("New commits arrived. Review them, then merge.");
    if (shown && shown.headline.trim() === "")
      return setFailure("A merge commit needs a headline.");
    setSending(true);
    setFailure(null);
    const started = await onMerge({
      write: {
        kind: "merge",
        pull: pull.id,
        expectedHead,
        method,
        headline: shown?.headline ?? null,
        body: shown?.body ?? null,
      },
      remote: remote.kind === "offer" && deleteRemote ? pull.head.branch : null,
      local: local.kind === "offer" && deleteLocal ? local.branch : null,
    });
    if (started === "started") {
      ref.current?.close();
      return onClose(true);
    }
    setSending(false);
    setFailure(sentNothing[started]);
  }

  const keys = (event: KeyboardEvent) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void confirm();
    }
  };

  return (
    <dialog
      ref={ref}
      className="merge-popover"
      aria-labelledby={`${id}-title`}
      aria-busy={sending}
      style={at ? { ...at, width: WIDTH } : undefined}
      onKeyDown={keys}
      onCancel={(event) => {
        if (sending) event.preventDefault();
        else onCancel(event);
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !sending) close();
      }}
    >
      <header>
        <h1 id={`${id}-title`}>
          Merge #{pull.number} into {pull.base}
        </h1>
        <span>{counted(pull.commits.total, "commit")}</span>
      </header>
      <fieldset className="merge-methods" disabled={sending}>
        <legend className="visually-hidden">How to merge</legend>
        {methods.map((choice) => (
          <label
            key={choice.method}
            htmlFor={`${id}-${choice.method}-choice`}
            className={choice.method === method ? "chosen" : undefined}
          >
            <input
              id={`${id}-${choice.method}-choice`}
              type="radio"
              name={`${id}-method`}
              value={choice.method}
              checked={choice.method === method}
              disabled={choice.off}
              autoFocus={choice.method === method}
              aria-describedby={`${id}-${choice.method}`}
              onChange={() => pick(choice.method)}
            />
            <span>
              {choice.label}
              <small id={`${id}-${choice.method}`}>{choice.note}</small>
            </span>
          </label>
        ))}
      </fieldset>
      {shown && (
        <section className="merge-message">
          <label htmlFor={`${id}-headline`}>Commit on {pull.base}</label>
          <input
            id={`${id}-headline`}
            value={shown.headline}
            readOnly={sending}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => edit({ headline: event.target.value })}
          />
          <textarea
            aria-label="Commit message"
            value={shown.body}
            readOnly={sending}
            rows={4}
            onChange={(event) => edit({ body: event.target.value })}
          />
        </section>
      )}
      {(remote.kind !== "none" || local.kind !== "none") && (
        <section className="merge-after">
          <fieldset disabled={sending}>
            <legend>After merging</legend>
            {remote.kind !== "none" && (
              <label htmlFor={`${id}-remote-choice`}>
                <input
                  id={`${id}-remote-choice`}
                  type="checkbox"
                  checked={
                    remote.kind === "offer"
                      ? deleteRemote
                      : remote.kind === "github"
                  }
                  disabled={remote.kind !== "offer"}
                  aria-describedby={`${id}-remote`}
                  onChange={(event) => setDeleteRemote(event.target.checked)}
                />
                <span>Delete {pull.head.branch} on GitHub</span>
                <small id={`${id}-remote`}>{remote.note}</small>
              </label>
            )}
            {local.kind !== "none" && (
              <label htmlFor={`${id}-local-choice`}>
                <input
                  id={`${id}-local-choice`}
                  type="checkbox"
                  checked={local.kind === "offer" && deleteLocal}
                  disabled={local.kind !== "offer"}
                  aria-describedby={`${id}-local`}
                  onChange={(event) => setDeleteLocal(event.target.checked)}
                />
                <span>Delete the local branch too</span>
                <small id={`${id}-local`}>
                  {local.kind === "offer"
                    ? `${local.name}. Undo brings it back.`
                    : `${local.name}. ${local.note}`}
                </small>
              </label>
            )}
          </fieldset>
        </section>
      )}
      {failure && (
        <p className="error-message" role="alert">
          {failure}
        </p>
      )}
      <footer>
        <span>Merging has no Undo.</span>
        <button
          type="button"
          className="button ghost"
          aria-disabled={sending}
          onClick={() => {
            if (!sending) close();
          }}
        >
          Cancel
        </button>
        <button
          type="button"
          className={`button ${anyway ? "danger" : "primary"}`}
          aria-disabled={sending}
          onClick={() => void confirm()}
        >
          {sending && (
            <LoaderCircle size={14} className="spin" aria-hidden="true" />
          )}
          {mergeLabel(method, anyway)}
        </button>
      </footer>
    </dialog>
  );
}
