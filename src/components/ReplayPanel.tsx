import { useEffect, useId, useRef, useState } from "react";
import { GitCommitHorizontal, X } from "lucide-react";
import { clearSubmitted } from "../commitDrafts";
import { inProgress } from "../domain/inProgress";
import type { InProgress } from "../domain/inProgress";
import { replayNames } from "../domain/merge";
import type { MergeState, ReplayProgress } from "../domain/merge";
import { problemFrom } from "../domain/repository";
import type {
  Head,
  Problem,
  ReplayOf,
  ReplayReview,
  RepositoryRoot,
} from "../domain/repository";
import type { Write } from "../domain/operations";
import { useDraftImpact } from "../draftProtection";
import * as repositories from "../repositories";
import { useRead } from "../useRead";
import type { Read } from "../useRead";
import type { Outcome, ReplayAbortOutcome } from "../useWrites";
import { commitOutput } from "./CommitBox";
import { OperationStrip } from "./OperationStrip";

type Notice = { message: string; error: boolean };

type StoppedProblem = { message: string; output: string };
/** Git stopped a start for a reason the panel's own state does not explain. */
type Stop = ReplayOf & { problem: StoppedProblem };

export function ReplayPanel({
  root,
  read,
  busy,
  write,
  abort,
  dismiss,
  review,
  onCloseReview,
  onInspect,
}: {
  root: RepositoryRoot;
  read: Read<MergeState>;
  busy: boolean;
  write: (worktree: RepositoryRoot, write: Write) => Promise<Outcome>;
  abort: (
    worktree: RepositoryRoot,
    of: ReplayOf,
    head: Head,
  ) => Promise<ReplayAbortOutcome>;
  /** Clears the write notice for a failure the review dialog answers itself. */
  dismiss: () => void;
  review: ReplayOf | null;
  onCloseReview: () => void;
  onInspect: () => void;
}) {
  const [notice, setNotice] = useState<Notice | null>(null);
  const [stop, setStop] = useState<Stop | null>(null);
  const progress =
    read.kind === "ready" && read.value.kind === "replay"
      ? read.value.progress
      : null;
  const dialog = review && (
    <ReplayReviewDialog
      key={JSON.stringify([root, review])}
      root={root}
      of={review}
      busy={busy}
      write={(request) => {
        setNotice(null);
        setStop(null);
        return write(root, request);
      }}
      dismiss={dismiss}
      onStopped={(shown, problem) =>
        setStop(
          problem.output === "" && shown.prediction.kind === "conflict"
            ? null
            : { kind: shown.kind, commit: shown.commit, problem },
        )
      }
      onClose={onCloseReview}
    />
  );
  const shown =
    read.kind === "ready" && progress ? inProgress(read.value) : null;
  return (
    <>
      {progress && shown?.kind === "running" && (
        <ReplayStrip
          key={shown.key}
          running={shown}
          progress={progress}
          stopped={
            stop?.kind === progress.kind && stop.commit === progress.commit
              ? stop.problem
              : null
          }
          busy={busy}
          write={(request) => {
            setNotice(null);
            setStop(null);
            return write(root, request);
          }}
          abort={async () => {
            setNotice(null);
            setStop(null);
            const { title } = replayNames[progress.kind];
            let result: ReplayAbortOutcome;
            try {
              result = await abort(
                root,
                { kind: progress.kind, commit: progress.commit },
                progress.destination,
              );
            } catch (error) {
              result = { kind: "failed", problem: problemFrom(error) };
            }
            setNotice(
              result.kind === "aborted"
                ? {
                    message: `${title} aborted. Its resolution Undo is closed, and earlier history is available again.`,
                    error: false,
                  }
                : {
                    message:
                      result.kind === "failed"
                        ? result.problem.message
                        : "Wait for the current operation to finish.",
                    error: true,
                  },
            );
            return result.kind === "aborted";
          }}
          onInspect={onInspect}
        />
      )}
      {notice && (notice.error || !progress) && (
        <section className="merge-controls" aria-label="Cherry-pick or revert">
          <div
            role={notice.error ? "alert" : "status"}
            className={notice.error ? "error-message" : "muted"}
          >
            {notice.message}
          </div>
        </section>
      )}
      {dialog}
    </>
  );
}

function ReplayStrip({
  running,
  progress,
  stopped,
  busy,
  write,
  abort,
  onInspect,
}: {
  running: Extract<InProgress, { kind: "running" }>;
  progress: ReplayProgress;
  stopped: StoppedProblem | null;
  busy: boolean;
  write: (write: Write) => Promise<Outcome>;
  abort: () => Promise<boolean>;
  onInspect: () => void;
}) {
  const [refusal, setRefusal] = useState<Problem | null>(null);
  return (
    <OperationStrip
      shown={running}
      busy={busy}
      onInspect={onInspect}
      onFinish={async (message, draft) => {
        if (progress.tree === null) return;
        setRefusal(null);
        const outcome = await write({
          operation: {
            kind: "finishReplay",
            of: { kind: progress.kind, commit: progress.commit },
            staged: progress.staged,
            tree: progress.tree,
            message,
          },
          expect: { head: progress.destination },
        });
        if (
          outcome.kind === "applied" ||
          (outcome.kind === "failed" &&
            (outcome.problem.kind === "raced" ||
              outcome.problem.kind === "afterHookFailed"))
        )
          clearSubmitted(progress.root, draft);
        else if (
          outcome.kind === "failed" &&
          (outcome.problem.kind === "hookFailed" ||
            outcome.problem.kind === "missingIdentity")
        )
          setRefusal(outcome.problem);
      }}
      onAbort={abort}
    >
      {(stopped || refusal) && (
        <div className="operation-detail">
          {stopped && (
            <div className="error-message commit-problem" role="alert">
              <p>{stopped.message}</p>
              {stopped.output && (
                <pre className="problem-detail">{stopped.output}</pre>
              )}
            </div>
          )}
          {refusal && commitOutput(refusal)}
        </div>
      )}
    </OperationStrip>
  );
}

function ReplayReviewDialog({
  root,
  of,
  busy,
  write,
  dismiss,
  onStopped,
  onClose,
}: {
  root: RepositoryRoot;
  of: ReplayOf;
  busy: boolean;
  write: (write: Write) => Promise<Outcome>;
  dismiss: () => void;
  onStopped: (shown: ReplayReview, problem: StoppedProblem) => void;
  onClose: () => void;
}) {
  const [review, refresh] = useRead(JSON.stringify([root, of]), () =>
    repositories.replayReview(root, of),
  );
  const [refusal, setRefusal] = useState<{
    message: string;
    problem: Problem | null;
  } | null>(null);
  const { frozen } = useDraftImpact();
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const title = useId();
  const { noun, title: action } = replayNames[of.kind];
  const shown = review.kind === "ready" ? review.value : null;
  useEffect(() => {
    dialog.current?.showModal();
    cancel.current?.focus();
  }, []);
  function leave() {
    dialog.current?.close();
    onClose();
  }
  function close() {
    if (!busy) leave();
  }
  async function confirm() {
    if (!shown || busy || frozen) return;
    setRefusal(null);
    const outcome = await write({
      operation: { kind: "replay", review: shown },
      expect: {
        head: {
          kind: "attached",
          reference: shown.destination.reference,
          oid: shown.destination.oid,
        },
      },
    });
    if (outcome.kind === "busy") {
      setRefusal({
        message: "Wait for the current operation to finish.",
        problem: null,
      });
    } else if (outcome.kind === "applied") {
      leave();
    } else if (outcome.problem.kind === "replayStopped") {
      onStopped(shown, outcome.problem);
      leave();
    } else if (
      outcome.problem.kind === "raced" ||
      outcome.problem.kind === "afterHookFailed"
    ) {
      leave();
    } else {
      dismiss();
      setRefusal({
        message:
          outcome.problem.kind === "staleView"
            ? `What this ${noun} would do changed since L1 Git showed it, so nothing changed. Review it again.`
            : outcome.problem.message,
        problem: outcome.problem,
      });
      refresh();
    }
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
        <GitCommitHorizontal size={20} />
        <button
          type="button"
          className="icon-button"
          aria-label={`Close ${noun} review`}
          disabled={busy}
          onClick={close}
        >
          <X size={17} />
        </button>
      </div>
      <h1 id={title}>{action} this commit</h1>
      {review.kind === "loading" && <p>Reading the commit and its branch…</p>}
      {review.kind === "error" && <p role="alert">{review.error.message}</p>}
      {refusal &&
        refusal.message !==
          (review.kind === "error" && review.error.message) && (
          <p role="alert">{refusal.message}</p>
        )}
      {refusal?.problem && commitOutput(refusal.problem)}
      {shown && (
        <>
          <dl className="merge-pair">
            <dt>Commit</dt>
            <dd>
              {shown.subject}
              <code>{shown.commit}</code>
            </dd>
            <dt>Destination</dt>
            <dd>
              {shown.destination.reference}
              <code>{shown.destination.oid}</code>
            </dd>
          </dl>
          <p>{predicted(shown)}</p>
        </>
      )}
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
            busy || frozen || !shown || shown.prediction.kind === "empty"
          }
          onClick={() => void confirm()}
        >
          {action}
        </button>
      </div>
    </dialog>
  );
}

function predicted({ prediction }: ReplayReview): string {
  switch (prediction.kind) {
    case "clean":
      return "Applies cleanly. L1 Git will commit it straight away, and Undo removes it.";
    case "conflict":
      return `Will conflict in: ${prediction.paths.join(", ")}. You resolve it in the app, then finish or abort.`;
    case "empty":
      return "These changes are already there, so there is nothing to apply.";
  }
}
