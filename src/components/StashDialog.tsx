import { useEffect, useId, useRef, useState } from "react";
import { Archive, LoaderCircle, X } from "lucide-react";
import { shownPaths, stashPushWrite } from "../domain/operations";
import type { Write } from "../domain/operations";
import type { Head, Problem } from "../domain/repository";
import type { Outcome } from "../useWrites";
import { messageKeys } from "./CommitBox";

type Props = {
  paths: readonly string[];
  includeUntracked: boolean;
  head: Head;
  onWrite: (write: Write) => Promise<Outcome>;
  onClose: () => void;
};

export function StashDialog({
  paths,
  includeUntracked,
  head,
  onWrite,
  onClose,
}: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const messageField = useRef<HTMLTextAreaElement>(null);
  const titleId = useId();
  const [message, setMessage] = useState("");
  const [untracked, setUntracked] = useState(includeUntracked);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
    messageField.current?.focus();
  }, []);
  const close = () => {
    dialog.current?.close();
    onClose();
  };
  const { shown, more } = shownPaths(paths);
  const everyChange = paths.length === 0;

  async function save() {
    if (saving) return;
    setSaving(true);
    setProblem(null);
    const outcome = await onWrite(
      stashPushWrite(message, untracked, paths, head),
    );
    setSaving(false);
    if (outcome.kind === "busy") {
      setProblem({
        kind: "transport",
        message: "Another change is still running. Try again when it ends.",
      });
      return;
    }
    if (outcome.kind === "failed") {
      setProblem(outcome.problem);
      return;
    }
    close();
  }

  return (
    <dialog
      ref={dialog}
      className="add-dialog branch-dialog tag-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="dialog-title">
          <div className="dialog-icon">
            <Archive size={20} />
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={close}
            aria-label="Close stash"
          >
            <X size={17} />
          </button>
        </div>
        <h1 id={titleId}>Stash changes</h1>
        <p>
          {everyChange
            ? "Stash every change in this worktree. You can undo this."
            : `Stash ${paths.length.toLocaleString()} ${paths.length === 1 ? "path" : "paths"}. You can undo this.`}
        </p>
        {!everyChange && (
          <ul className="dialog-paths" aria-label="Paths to stash">
            {shown.map((path) => (
              <li key={path}>{path}</li>
            ))}
            {more > 0 && (
              <li className="muted">and {more.toLocaleString()} more</li>
            )}
          </ul>
        )}
        <label htmlFor={`${titleId}-message`}>Message</label>
        <textarea
          id={`${titleId}-message`}
          ref={messageField}
          className="commit-description"
          rows={3}
          spellCheck
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={messageKeys(() => void save())}
        />
        <p className="field-hint">
          Optional. An empty message leaves Git’s “WIP on …” text.
        </p>
        <label className="dialog-option">
          <input
            type="checkbox"
            checked={untracked}
            onChange={(event) => setUntracked(event.target.checked)}
          />
          Include untracked
        </label>
        {problem && (
          <p className="error-message" role="alert">
            {problem.message}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="button secondary" onClick={close}>
            Cancel
          </button>
          <button
            type="submit"
            className="button primary"
            aria-disabled={saving}
          >
            {saving && <LoaderCircle size={14} className="spin" />}
            Stash
          </button>
        </div>
      </form>
    </dialog>
  );
}
