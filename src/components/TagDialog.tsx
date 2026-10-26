import { useEffect, useId, useRef, useState } from "react";
import { LoaderCircle, Tag as TagIcon, Trash2, X } from "lucide-react";
import {
  answeredInTagDialog,
  createTagWrite,
  deleteTagWrite,
  isAnnotated,
} from "../domain/operations";
import type { TagAsk, Write } from "../domain/operations";
import type { Head, Problem } from "../domain/repository";
import type { Outcome } from "../useWrites";
import { commitOutput, messageKeys } from "./CommitBox";
import { ConfirmDialog } from "./ConfirmDialog";

type Props = {
  ask: TagAsk;
  head: Head;
  onWrite: (write: Write) => Promise<Outcome>;
  onClose: () => void;
};

export function TagDialog(props: Props) {
  return props.ask.kind === "delete" ? (
    <DeleteTagDialog {...props} ask={props.ask} />
  ) : (
    <CreateTagDialog {...props} ask={props.ask} />
  );
}

function CreateTagDialog({
  ask,
  head,
  onWrite,
  onClose,
}: Props & { ask: Extract<TagAsk, { kind: "create" }> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const errorId = useId();
  const hintId = useId();
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [problem, setProblem] = useState<Problem | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
    input.current?.focus();
  }, []);
  const close = () => {
    dialog.current?.close();
    onClose();
  };
  const ready = name.trim() !== "" && !saving;
  const badName = problem?.kind === "invalidRef";

  async function save() {
    if (!ready) return;
    setSaving(true);
    setProblem(null);
    const outcome = await onWrite(createTagWrite(name, ask.at, message, head));
    setSaving(false);
    if (outcome.kind === "busy") {
      setProblem({
        kind: "transport",
        message: "Another change is still running. Try again when it ends.",
      });
      return;
    }
    if (outcome.kind === "failed" && answeredInTagDialog(outcome.problem)) {
      setProblem(outcome.problem);
      if (outcome.problem.kind === "invalidRef") input.current?.focus();
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
            <TagIcon size={20} />
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={close}
            aria-label="Close create tag"
          >
            <X size={17} />
          </button>
        </div>
        <h1 id={titleId}>Create tag</h1>
        <p>
          The tag goes on commit <code>{ask.at.slice(0, 7)}</code>
          {ask.subject === "" ? "" : ` “${ask.subject}”`}.
        </p>
        <label htmlFor={`${titleId}-name`}>Tag name</label>
        <input
          id={`${titleId}-name`}
          ref={input}
          className="branch-name-input"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          value={name}
          aria-invalid={badName}
          aria-describedby={badName ? errorId : undefined}
          onChange={(event) => {
            setName(event.target.value);
            setProblem(null);
          }}
        />
        {problem && badName && (
          <p id={errorId} className="error-message" role="alert">
            {problem.message}
          </p>
        )}
        <label htmlFor={`${titleId}-message`} className="tag-message-label">
          Message
        </label>
        <textarea
          id={`${titleId}-message`}
          className="commit-description"
          rows={4}
          spellCheck
          value={message}
          aria-describedby={hintId}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={messageKeys(() => void save())}
        />
        <p id={hintId} className="field-hint">
          Optional. A message makes an annotated tag.
        </p>
        {problem && !badName && (
          <>
            <p className="error-message" role="alert">
              {problem.message}
            </p>
            {commitOutput(problem)}
          </>
        )}
        <div className="dialog-actions">
          <button type="button" className="button secondary" onClick={close}>
            Cancel
          </button>
          <button
            type="submit"
            className="button primary"
            aria-disabled={!ready}
          >
            {saving && <LoaderCircle size={14} className="spin" />}
            Create tag
          </button>
        </div>
      </form>
    </dialog>
  );
}

function DeleteTagDialog({
  ask: { tag },
  head,
  onWrite,
  onClose,
}: Props & { ask: Extract<TagAsk, { kind: "delete" }> }) {
  return (
    <ConfirmDialog
      icon={Trash2}
      title={`Delete tag ${tag.name}?`}
      closeLabel="Close delete tag"
      confirm="Delete tag"
      onConfirm={() => void onWrite(deleteTagWrite(tag, head))}
      onClose={onClose}
    >
      <p>
        {tag.name} is {isAnnotated(tag) ? "an annotated" : "a lightweight"} tag
        on commit {tag.oid.slice(0, 7)}, and you can undo this.
      </p>
    </ConfirmDialog>
  );
}
