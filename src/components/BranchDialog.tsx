import { useEffect, useId, useRef, useState } from "react";
import {
  GitBranchPlus,
  LoaderCircle,
  PencilLine,
  Trash2,
  X,
} from "lucide-react";
import * as repositories from "../repositories";
import { branchWrite, notMergedInto } from "../domain/operations";
import type { BranchAsk, Write } from "../domain/operations";
import { problemFrom } from "../domain/repository";
import type {
  Branch,
  BranchMerged,
  FullRef,
  Head,
  Problem,
  RepositoryRoot,
} from "../domain/repository";
import type { Outcome } from "../useWrites";
import { ConfirmDialog } from "./ConfirmDialog";

type Props = {
  ask: BranchAsk;
  root: RepositoryRoot;
  head: Head;
  onWrite: (write: Write) => Promise<Outcome>;
  /** The branch a create or rename left, so the app can show it. */
  onNamed: (branch: Branch) => void;
  onClose: () => void;
};

export function BranchDialog(props: Props) {
  return props.ask.kind === "delete" ? (
    <DeleteBranchDialog {...props} ask={props.ask} />
  ) : (
    <NameBranchDialog {...props} ask={props.ask} />
  );
}

function NameBranchDialog({
  ask,
  head,
  onWrite,
  onNamed,
  onClose,
}: Props & { ask: Exclude<BranchAsk, { kind: "delete" }> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const errorId = useId();
  const [name, setName] = useState(ask.kind === "rename" ? ask.name : "");
  const [problem, setProblem] = useState<Problem | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
    input.current?.select();
  }, []);
  const close = () => {
    dialog.current?.close();
    onClose();
  };
  const creating = ask.kind === "create";
  const ready = name.trim() !== "" && !saving;

  async function save() {
    if (!ready) return;
    setSaving(true);
    setProblem(null);
    const operation =
      ask.kind === "create"
        ? { kind: "createBranch" as const, name, at: ask.at }
        : { kind: "renameBranch" as const, branch: ask.branch, to: name };
    const outcome = await onWrite(branchWrite(operation, head));
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
      input.current?.focus();
      return;
    }
    close();
    onNamed({
      kind: "local",
      reference: `refs/heads/${name}` as FullRef,
      name,
      oid: ask.kind === "create" ? ask.at.oid : ask.branch.oid,
      upstream: null,
    });
  }

  return (
    <dialog
      ref={dialog}
      className="add-dialog branch-dialog"
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
            {creating ? <GitBranchPlus size={20} /> : <PencilLine size={20} />}
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={close}
            aria-label={creating ? "Close new branch" : "Close rename branch"}
          >
            <X size={17} />
          </button>
        </div>
        <h1 id={titleId}>{creating ? "New branch" : `Rename ${ask.name}`}</h1>
        <p>
          {ask.kind === "create"
            ? `The branch starts at ${ask.from}${ask.at.kind === "remote" ? `, and Git sets ${ask.from} as its upstream` : ""}.`
            : "Git renames the branch, moves its settings, and updates every worktree that has it checked out. You can undo this."}
        </p>
        <label htmlFor={`${titleId}-name`}>Branch name</label>
        <input
          id={`${titleId}-name`}
          ref={input}
          className="branch-name-input"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          value={name}
          aria-invalid={problem !== null}
          aria-describedby={problem ? errorId : undefined}
          onChange={(event) => {
            setName(event.target.value);
            setProblem(null);
          }}
        />
        {problem && (
          <p id={errorId} className="error-message" role="alert">
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
            aria-disabled={!ready}
          >
            {saving && <LoaderCircle size={14} className="spin" />}
            {creating ? "Create branch" : "Rename"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

type Merge =
  | { kind: "reading" }
  | { kind: "read"; merged: BranchMerged }
  | { kind: "unreadable"; problem: Problem };

function DeleteBranchDialog({
  ask,
  root,
  head,
  onWrite,
  onClose,
}: Props & { ask: Extract<BranchAsk, { kind: "delete" }> }) {
  const [merge, setMerge] = useState<Merge>({ kind: "reading" });
  useEffect(() => {
    let current = true;
    repositories.branchMerged(root, ask.branch).then(
      (merged) => current && setMerge({ kind: "read", merged }),
      (error: unknown) =>
        current &&
        setMerge({ kind: "unreadable", problem: problemFrom(error) }),
    );
    return () => {
      current = false;
    };
  }, [root, ask.branch]);
  const headName =
    head.kind === "attached"
      ? `HEAD (${head.reference.replace(/^refs\/heads\//, "")})`
      : "HEAD";
  const operation = { kind: "deleteBranch" as const, branch: ask.branch };
  return (
    <ConfirmDialog
      icon={Trash2}
      title={`Delete branch ${ask.name}?`}
      closeLabel="Close delete branch"
      confirm="Delete branch"
      onConfirm={() => void onWrite(branchWrite(operation, head))}
      onClose={onClose}
    >
      <p role="status">
        {merge.kind === "reading" && (
          <>
            <LoaderCircle size={14} className="spin" /> Checking whether{" "}
            {ask.name} is merged…
          </>
        )}
        {merge.kind === "unreadable" &&
          `L1 Git could not tell whether ${ask.name} is merged. ${merge.problem.message}`}
        {merge.kind === "read" &&
          (notMergedInto(ask.name, merge.merged, headName) ??
            `${ask.name} is merged into ${headName}${merge.merged.upstream ? " and its upstream" : ""}.`)}
      </p>
      <p>
        L1 Git keeps its commits and settings in the undo history, so you can
        undo this.
      </p>
    </ConfirmDialog>
  );
}
