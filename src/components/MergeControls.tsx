import { useEffect, useId, useRef, useState } from "react";
import { GitMerge, X } from "lucide-react";
import * as repositories from "../repositories";
import type { MergeAction, MergeReview, MergeState } from "../domain/merge";
import type { RepositoryRoot } from "../domain/repository";
import { problemFrom } from "../domain/repository";
import { useRead } from "../useRead";
import type { Read } from "../useRead";
import { useDraftImpact } from "../draftProtection";
import { clearSubmitted, useCommitDraft } from "../commitDrafts";
import { messageFor, splitMessage } from "../domain/commitMessage";
import {
  discardConsentedResolutions,
  resolutionConsent,
} from "../resolutionDrafts";
import type { MergeCommandOutcome } from "../useWrites";
import { ConfirmDialog } from "./ConfirmDialog";

export function MergePair({ review }: { review: MergeReview }) {
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
  reviewOpen,
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
  reviewOpen: boolean;
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
  if (
    !notice &&
    !reviewOpen &&
    (read.kind === "loading" || (state?.kind === "idle" && !eligible))
  )
    return null;
  return (
    <section className="merge-controls" aria-label="Upstream merge">
      {state?.kind === "idle" && eligible && (
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
      {state?.kind === "attention" && (
        <div role="alert">
          <strong>Merge needs attention</strong>
          <p>{state.message}</p>
          {state.session && <MergePair review={state.session.review} />}
        </div>
      )}
      {state?.kind === "active" && (
        <ActiveMerge
          key={state.session.id}
          state={state}
          busy={busy}
          run={execute}
          onInspect={onInspect}
        />
      )}
      {reviewOpen && (
        <MergeReviewDialog
          root={root}
          busy={busy}
          run={execute}
          onClose={onCloseReview}
        />
      )}
    </section>
  );
}

function ActiveMerge({
  state,
  busy,
  run,
  onInspect,
}: {
  state: Extract<MergeState, { kind: "active" }>;
  busy: boolean;
  run: (action: MergeAction) => Promise<MergeCommandOutcome>;
  onInspect: () => void;
}) {
  const { session } = state;
  const root = session.review.root;
  const [draft, setDraft] = useCommitDraft(root);
  const impact = useDraftImpact();
  const [aborting, setAborting] = useState<ReturnType<
    typeof resolutionConsent
  > | null>(null);
  const message = messageFor(draft.draft, null);
  const dirty = impact.resolutions.some((draft) => draft.root === root);
  const disabled = busy || impact.frozen;
  async function finish() {
    if (
      disabled ||
      dirty ||
      !state.tree ||
      state.unresolved.length > 0 ||
      !message.trim()
    )
      return;
    const result = await run({
      kind: "finish",
      session: session.id,
      staged: state.staged,
      tree: state.tree,
      message,
    });
    if (result.kind === "merged" && result.report.outcome.kind === "finished")
      clearSubmitted(root, draft);
  }
  return (
    <>
      <strong>Merge in progress</strong>
      <details>
        <summary>
          {session.review.source.reference} into{" "}
          {session.review.destination.reference}
        </summary>
        <MergePair review={session.review} />
      </details>
      {state.upstreamMoved && (
        <p>
          The upstream has moved. This merge still uses the source commit you
          reviewed above.
        </p>
      )}
      <p>
        {state.unresolved.length
          ? `${state.unresolved.length} unresolved path${state.unresolved.length === 1 ? "" : "s"}. Resolve and mark each path.`
          : "All conflicts are resolved. Review the staged result before finishing."}
      </p>
      <button className="button secondary" onClick={onInspect}>
        Review staged result and conflicts
      </button>
      {state.tree && (
        <details>
          <summary>Reviewed staged tree</summary>
          <code>{state.tree}</code>
        </details>
      )}
      <label className="merge-message">
        Merge commit message
        <input
          aria-label="Merge commit message"
          className="commit-summary"
          value={draft.draft.summary}
          placeholder={session.suggestedMessage}
          readOnly={disabled}
          onChange={(event) =>
            setDraft({
              draft: { ...draft.draft, summary: event.target.value },
              amend: null,
            })
          }
        />
        <textarea
          aria-label="Merge description"
          className="commit-description"
          value={draft.draft.description}
          placeholder="Description (optional)"
          readOnly={disabled}
          onChange={(event) =>
            setDraft({
              draft: { ...draft.draft, description: event.target.value },
              amend: null,
            })
          }
        />
      </label>
      <button
        className="button secondary"
        disabled={disabled}
        onClick={() =>
          setDraft({
            draft: splitMessage(session.suggestedMessage),
            amend: null,
          })
        }
      >
        Use suggested message
      </button>
      {dirty && (
        <p role="status">
          Unsaved conflict results must be saved before Finish. Abort asks
          before discarding the drafts shown when you confirm.
        </p>
      )}
      <div className="merge-actions">
        <button
          className="button primary"
          disabled={
            disabled ||
            dirty ||
            state.tree === null ||
            state.unresolved.length > 0 ||
            !message.trim()
          }
          onClick={() => void finish()}
        >
          Finish merge
        </button>
        <button
          className="button secondary"
          disabled={disabled}
          onClick={() =>
            setAborting(resolutionConsent(root, session.footprint))
          }
        >
          Abort merge…
        </button>
      </div>
      <p className="muted">
        Start, Finish, and Abort cannot be undone. Resolution edits have Undo
        and Redo until Finish or Abort.
      </p>
      {aborting && (
        <ConfirmDialog
          icon={GitMerge}
          title="Abort this merge?"
          closeLabel="Close abort merge"
          confirm="Discard merge and abort"
          onClose={() => setAborting(null)}
          onConfirm={() => {
            if (disabled) return;
            void run({ kind: "abort", session: session.id }).then((result) => {
              if (
                result.kind === "merged" &&
                result.report.outcome.kind === "aborted"
              )
                discardConsentedResolutions(aborting);
            });
          }}
        >
          <p>
            Discard the merge result and saved resolutions in its affected
            paths. Unrelated tracked changes block Abort; untracked and ignored
            files are preserved.
          </p>
          {aborting.length > 0 && (
            <p>
              Also discard these resolution drafts if they have not changed
              since this confirmation opened:{" "}
              {aborting.map(([, draft]) => draft.snapshot.path).join(", ")}.
            </p>
          )}
          <p>
            The commit message draft stays available. This action cannot be
            undone.
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}

function MergeReviewDialog({
  root,
  busy,
  run,
  onClose,
}: {
  root: RepositoryRoot;
  busy: boolean;
  run: (action: MergeAction) => Promise<MergeCommandOutcome>;
  onClose: () => void;
}) {
  const [review, refresh] = useRead(root, () => repositories.mergeReview(root));
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
    if (result.kind === "merged" && result.report.outcome.kind === "started") {
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
      <h1 id={title}>Merge upstream</h1>
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
        Start requires clean tracked files and an ordinary index. Git stops
        before committing, including when there are no conflicts.
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
          disabled={busy || frozen || amending || review.kind !== "ready"}
          onClick={() => void start()}
        >
          Start merge
        </button>
      </div>
    </dialog>
  );
}
