import { useEffect, useId, useState } from "react";
import { FolderGit2, LoaderCircle } from "lucide-react";
import * as repositories from "../repositories";
import { shortBranch, shortRemote } from "../domain/refs";
import { problemFrom } from "../domain/repository";
import type {
  Problem,
  RepositoryRoot,
  WorktreeReview,
} from "../domain/repository";
import type { TryAsk } from "../shell/useRefWrites";
import type { CreateWorktreeOutcome } from "../useWrites";
import { DialogHeader, busyProblem, useModalDialog } from "./Dialog";

type Props = {
  root: RepositoryRoot;
  ask: TryAsk;
  onCreate: (folder: string) => Promise<CreateWorktreeOutcome>;
  onClose: () => void;
};

type Form =
  | { kind: "reviewing" }
  | { kind: "refused"; problem: Problem }
  | {
      kind: "editing";
      review: WorktreeReview;
      folder: string;
      failure: Problem | null;
    }
  | { kind: "creating"; review: WorktreeReview; folder: string };

function branchLine({ branch }: WorktreeReview) {
  const name = shortBranch(branch.reference);
  if (branch.kind === "existing") return name;
  return branch.upstream === null
    ? `${name}, new`
    : `${name}, new, tracks ${shortRemote(branch.upstream)}`;
}

export function TryLocallyDialog({ root, ask, onCreate, onClose }: Props) {
  const titleId = useId();
  const errorId = useId();
  const [form, setForm] = useState<Form>({ kind: "reviewing" });
  const { ref, close, onCancel } = useModalDialog(onClose);
  useEffect(() => {
    let current = true;
    repositories.worktreeReview(root, ask.source).then(
      (review) =>
        current &&
        setForm({
          kind: "editing",
          review,
          folder: review.folder,
          failure: null,
        }),
      (error: unknown) =>
        current && setForm({ kind: "refused", problem: problemFrom(error) }),
    );
    return () => {
      current = false;
    };
  }, [root, ask.source]);
  const problem =
    form.kind === "refused"
      ? form.problem
      : form.kind === "editing"
        ? form.failure
        : null;
  const ready = form.kind === "editing" && form.folder.trim() !== "";

  async function create() {
    if (form.kind !== "editing" || !ready) return;
    const { review, folder } = form;
    setForm({ kind: "creating", review, folder });
    const outcome = await onCreate(folder);
    if (outcome.kind === "created") {
      close();
      return;
    }
    setForm({
      kind: "editing",
      review,
      folder,
      failure: outcome.kind === "busy" ? busyProblem : outcome.problem,
    });
  }

  return (
    <dialog
      ref={ref}
      className="add-dialog branch-dialog"
      aria-labelledby={titleId}
      onCancel={onCancel}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <DialogHeader
          icon={<FolderGit2 size={20} />}
          titleId={titleId}
          title={`Try ${ask.name} locally`}
          closeLabel="Close try it locally"
          onClose={close}
        />
        <p>
          Git checks the branch out in a folder of its own. Your current branch
          and uncommitted changes stay as they are.
        </p>
        {form.kind === "reviewing" && (
          <p className="muted" role="status">
            <LoaderCircle size={14} className="spin" /> Reading what Git would
            check out…
          </p>
        )}
        {(form.kind === "editing" || form.kind === "creating") && (
          <>
            <label htmlFor={`${titleId}-folder`}>Folder</label>
            <input
              id={`${titleId}-folder`}
              className="branch-name-input"
              autoFocus
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              value={form.folder}
              readOnly={form.kind === "creating"}
              aria-invalid={problem !== null}
              aria-describedby={problem ? errorId : undefined}
              onChange={(event) =>
                form.kind === "editing" &&
                setForm({
                  ...form,
                  folder: event.target.value,
                  failure: null,
                })
              }
            />
            <p>
              Local branch: <strong>{branchLine(form.review)}</strong>
            </p>
          </>
        )}
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
            {form.kind === "creating" && (
              <LoaderCircle size={14} className="spin" />
            )}
            Create worktree
          </button>
        </div>
      </form>
    </dialog>
  );
}
