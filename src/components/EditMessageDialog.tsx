import { useEffect, useRef, useState } from "react";
import { LoaderCircle, PencilLine, X } from "lucide-react";
import { loadMessage, messageFor } from "../domain/commitMessage";
import type { Draft, Loaded } from "../domain/commitMessage";
import { commitWrite } from "../domain/operations";
import type { Write } from "../domain/operations";
import { problemFrom } from "../domain/repository";
import type {
  Problem,
  RepositoryRoot,
  WorktreeStatus,
} from "../domain/repository";
import type { Outcome } from "../useWrites";
import { commitMessage, submits } from "./CommitBox";

export function EditMessageDialog({
  status,
  onSave,
  onClose,
}: {
  status: WorktreeStatus;
  onSave: (worktree: RepositoryRoot, write: Write) => Promise<Outcome>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { root, head } = status;
  const oid = head.kind === "unborn" ? null : head.oid;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => dialog.current?.showModal(), []);
  useEffect(() => {
    if (oid === null) return;
    let current = true;
    commitMessage(root, oid).then(
      (message) => {
        if (!current) return;
        const read = loadMessage(message);
        setLoaded(read);
        setDraft(read.draft);
      },
      (error: unknown) => current && setProblem(problemFrom(error)),
    );
    return () => {
      current = false;
    };
  }, [root, oid]);
  const message = draft && messageFor(draft, loaded);
  const ready =
    draft !== null &&
    draft.summary.trim() !== "" &&
    message !== loaded?.message &&
    !saving;

  async function save() {
    if (!ready || message === null) return;
    setSaving(true);
    setProblem(null);
    const outcome = await onSave(
      root,
      commitWrite("editMessage", status, message),
    );
    setSaving(false);
    if (outcome.kind === "busy") return;
    if (outcome.kind === "applied" || outcome.problem.kind === "raced")
      onClose();
    else setProblem(outcome.problem);
  }

  return (
    <dialog
      ref={dialog}
      className="add-dialog edit-message-dialog"
      aria-labelledby="edit-message-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
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
            <PencilLine size={20} />
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="Close edit message"
          >
            <X size={17} />
          </button>
        </div>
        <h1 id="edit-message-title">Edit message</h1>
        <p>
          L1 Git replaces commit <code>{oid?.slice(0, 7)}</code> with one that
          has the same changes and parents. Staged changes stay staged.
        </p>
        {draft === null ? (
          problem === null && (
            <p role="status">
              <LoaderCircle size={14} className="spin" /> Reading the message…
            </p>
          )
        ) : (
          <div className="edit-message-fields">
            <input
              className="commit-summary"
              aria-label="Summary"
              autoFocus
              autoComplete="off"
              spellCheck
              value={draft.summary}
              onChange={(event) =>
                setDraft({ ...draft, summary: event.target.value })
              }
            />
            <textarea
              className="commit-description"
              aria-label="Description"
              placeholder="Description"
              rows={6}
              spellCheck
              value={draft.description}
              onChange={(event) =>
                setDraft({ ...draft, description: event.target.value })
              }
              onKeyDown={(event) => {
                if (submits(event)) {
                  event.preventDefault();
                  void save();
                }
              }}
            />
          </div>
        )}
        {problem && (
          <p className="error-message" role="alert">
            {problem.message}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={!ready}>
            {saving && <LoaderCircle size={14} className="spin" />}
            Save message
          </button>
        </div>
      </form>
    </dialog>
  );
}
