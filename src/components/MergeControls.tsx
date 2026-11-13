import { useEffect, useId, useRef, useState } from "react";
import { GitMerge, X } from "lucide-react";
import * as repositories from "../repositories";
import type {
  MergeAction,
  MergeReview,
  MergeState,
  MergeSelection,
} from "../domain/merge";
import type { RepositoryRoot } from "../domain/repository";
import { problemFrom } from "../domain/repository";
import { useRead } from "../useRead";
import type { Read } from "../useRead";
import { useDraftImpact } from "../draftProtection";
import { clearSubmitted, useCommitDraft } from "../commitDrafts";
import { inProgress } from "../domain/inProgress";
import type { MergeCommandOutcome } from "../useWrites";
import { OperationStrip } from "./OperationStrip";

function MergePair({ review }: { review: MergeReview }) {
  return (
    <dl className="merge-pair">
      <dt>Source</dt>
      <dd>
        {review.source.reference}
        <code>{review.source.oid}</code>
      </dd>
      <dt>Destination</dt>
      <dd>
        {review.destination.reference}
        <code>{review.destination.oid}</code>
      </dd>
    </dl>
  );
}

export function MergeControls({
  root,
  read,
  refresh,
  eligible,
  busy,
  review,
  onReview,
  onCloseReview,
  run,
  onInspect,
}: {
  root: RepositoryRoot;
  read: Read<MergeState>;
  refresh: () => void;
  eligible: boolean;
  busy: boolean;
  review: MergeSelection | null;
  onReview: () => void;
  onCloseReview: () => void;
  run: (action: MergeAction) => Promise<MergeCommandOutcome>;
  onInspect: () => void;
}) {
  const [notice, setNotice] = useState<{
    message: string;
    error: boolean;
  } | null>(null);
  const { frozen } = useDraftImpact();
  async function execute(action: MergeAction) {
    let result: MergeCommandOutcome;
    try {
      result = await run(action);
    } catch (error) {
      result = { kind: "failed", problem: problemFrom(error) };
    }
    if (result.kind === "failed")
      setNotice({ message: result.problem.message, error: true });
    else if (result.kind === "busy")
      setNotice({
        message: "Wait for the current operation to finish.",
        error: true,
      });
    else {
      const outcome = result.report.outcome;
      switch (outcome.kind) {
        case "started":
          setNotice(
            outcome.problem ? { message: outcome.problem, error: true } : null,
          );
          break;
        case "notStarted":
          setNotice({ message: outcome.problem, error: true });
          break;
        case "upToDate":
          setNotice({
            message:
              "The destination already contains the selected source. No files or refs changed.",
            error: false,
          });
          break;
        case "fastForwarded":
          setNotice({
            message: `Fast-forwarded to ${outcome.commit}. ${outcome.problem ?? "Push remains a separate action."}`,
            error: outcome.problem !== null,
          });
          break;
        case "finished":
          setNotice({
            message:
              outcome.problem ??
              `Merge committed as ${outcome.commit}. Push remains a separate action.`,
            error: outcome.problem !== null,
          });
          break;
        case "aborted":
          setNotice({
            message:
              "Merge aborted. Resolution Undo is closed; earlier history is available again.",
            error: false,
          });
          break;
      }
    }
    refresh();
    return result;
  }
  const state = read.kind === "ready" ? read.value : null;
  const shown = state?.kind === "replay" ? null : inProgress(state);
  const operation = shown?.kind === "none" ? null : shown;
  const offer = state?.kind === "idle" && eligible;
  return (
    <>
      {operation && (
        <OperationStrip
          key={operation.kind === "running" ? operation.key : operation.kind}
          shown={operation}
          busy={busy}
          onInspect={onInspect}
          onFinish={async (message, draft) => {
            if (state?.kind !== "active" || state.tree === null) return;
            const result = await execute({
              kind: "finish",
              session: state.session.id,
              staged: state.staged,
              tree: state.tree,
              message,
            });
            if (
              result.kind === "merged" &&
              result.report.outcome.kind === "finished"
            )
              clearSubmitted(root, draft);
          }}
          onAbort={async () => {
            if (state?.kind !== "active") return false;
            const result = await execute({
              kind: "abort",
              session: state.session.id,
            });
            return (
              result.kind === "merged" &&
              result.report.outcome.kind === "aborted"
            );
          }}
        />
      )}
      {(offer || notice || read.kind === "error") && (
        <section className="merge-controls" aria-label="Branch merge">
          {offer && (
            <div className="merge-actions">
              <button
                className="button secondary"
                disabled={busy || frozen}
                onClick={onReview}
              >
                <GitMerge size={14} /> Merge upstream…
              </button>
            </div>
          )}
          {notice && (
            <div
              role={notice.error ? "alert" : "status"}
              className={notice.error ? "error-message" : "muted"}
            >
              {notice.message}
            </div>
          )}
          {read.kind === "error" && <p role="alert">{read.error.message}</p>}
        </section>
      )}
      {review && (
        <MergeReviewDialog
          key={JSON.stringify([root, review])}
          root={root}
          selection={review}
          busy={busy}
          run={execute}
          onClose={onCloseReview}
        />
      )}
    </>
  );
}

function MergeReviewDialog({
  root,
  selection,
  busy,
  run,
  onClose,
}: {
  root: RepositoryRoot;
  selection: MergeSelection;
  busy: boolean;
  run: (action: MergeAction) => Promise<MergeCommandOutcome>;
  onClose: () => void;
}) {
  const [review, refresh] = useRead(JSON.stringify([root, selection]), () =>
    repositories.mergeReview(root, selection),
  );
  const [problem, setProblem] = useState<string | null>(null);
  const { frozen } = useDraftImpact();
  const [draft] = useCommitDraft(root);
  const amending = draft.amend !== null;
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const title = useId();
  useEffect(() => {
    dialog.current?.showModal();
    cancel.current?.focus();
  }, []);
  function close() {
    if (busy) return;
    dialog.current?.close();
    onClose();
  }
  async function start() {
    if (review.kind !== "ready" || busy || frozen || amending) return;
    const result = await run({ kind: "start", review: review.value });
    if (
      result.kind === "merged" &&
      ["started", "fastForwarded", "upToDate"].includes(
        result.report.outcome.kind,
      )
    ) {
      dialog.current?.close();
      onClose();
    } else if (result.kind === "failed") {
      setProblem(result.problem.message);
      refresh();
    } else if (
      result.kind === "merged" &&
      result.report.outcome.kind === "notStarted"
    )
      setProblem(result.report.outcome.problem);
  }
  return (
    <dialog
      ref={dialog}
      className="add-dialog merge-dialog"
      aria-labelledby={title}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <div className="dialog-title">
        <GitMerge size={20} />
        <button
          type="button"
          className="icon-button"
          aria-label="Close merge review"
          disabled={busy}
          onClick={close}
        >
          <X size={17} />
        </button>
      </div>
      <h1 id={title}>
        {selection.kind === "upstream"
          ? "Merge upstream"
          : "Merge into current branch"}
      </h1>
      <p>
        Merge the reviewed source into this worktree's current branch. Fetch and
        Push remain separate actions.
      </p>
      {review.kind === "ready" && <MergePair review={review.value} />}
      {review.kind === "loading" && <p>Reading source and destination…</p>}
      {review.kind === "error" && <p role="alert">{review.error.message}</p>}
      {problem && <p role="alert">{problem}</p>}
      {amending && (
        <p role="alert">
          Turn off Amend before starting a merge so its saved message draft
          stays protected.
        </p>
      )}
      <p>
        {review.kind === "ready" && review.value.plan === "upToDate"
          ? "Up to date. The destination already contains this source. No write is needed."
          : review.kind === "ready" && review.value.plan === "fastForward"
            ? "Fast-forward. Move the current branch to the source commit without creating a merge commit. This cannot be undone here."
            : "Merge commit. Start requires clean tracked files and an ordinary index. Git stops before committing so you can review and Finish or Abort."}
      </p>
      <p>
        Merge lifecycle actions cannot be undone. Abort cancels an active merge.
        Resolution edits retain Undo until Finish or Abort.
      </p>
      <div className="dialog-actions">
        <button
          ref={cancel}
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={close}
        >
          Cancel
        </button>
        <button
          type="button"
          className="button primary"
          disabled={
            busy ||
            frozen ||
            amending ||
            review.kind !== "ready" ||
            review.value.plan === "upToDate"
          }
          onClick={() => void start()}
        >
          {review.kind === "ready" && review.value.plan === "fastForward"
            ? "Fast-forward"
            : "Start merge"}
        </button>
      </div>
    </dialog>
  );
}
