import { useState } from "react";
import { inProgress } from "../domain/inProgress";
import type { MergeState, RebaseProgress } from "../domain/merge";
import { problemFrom } from "../domain/repository";
import type {
  Head,
  Problem,
  RebaseOf,
  RepositoryRoot,
} from "../domain/repository";
import type { Write } from "../domain/operations";
import type { Read } from "../useRead";
import type { Outcome, ReplayAbortOutcome } from "../useWrites";
import { commitOutput } from "./CommitBox";
import { OperationStrip } from "./OperationStrip";

type Notice = { message: string; error: boolean };

/** What Git printed when it stopped on a step, keyed by the step it stopped on. */
type Stop = { step: string; message: string; output: string };

const ofProgress = ({
  branch,
  onto,
  origHead,
  step,
}: RebaseProgress): RebaseOf => ({ branch, onto, origHead, step });

/**
 * A rebase Git holds stopped on a step: Continue rebase, Skip commit when the
 * result matches HEAD, and Abort rebase. Only the request that ends the rebase
 * lands in Undo, as one entry for all of it.
 */
export function RebasePanel({
  root,
  read,
  busy,
  write,
  abort,
  onInspect,
}: {
  root: RepositoryRoot;
  read: Read<MergeState>;
  busy: boolean;
  write: (worktree: RepositoryRoot, write: Write) => Promise<Outcome>;
  abort: (
    worktree: RepositoryRoot,
    of: RebaseOf,
    head: Head,
  ) => Promise<ReplayAbortOutcome>;
  onInspect: () => void;
}) {
  const [notice, setNotice] = useState<Notice | null>(null);
  const [stop, setStop] = useState<Stop | null>(null);
  const [refusal, setRefusal] = useState<Problem | null>(null);
  const progress =
    read.kind === "ready" && read.value.kind === "rebase"
      ? read.value.progress
      : null;
  const shown =
    progress && read.kind === "ready" ? inProgress(read.value) : null;
  async function proceed(progress: RebaseProgress, request: Write) {
    setNotice(null);
    setStop(null);
    setRefusal(null);
    const outcome = await write(root, request);
    if (outcome.kind === "failed" && outcome.problem.kind === "rebaseStopped") {
      setStop({
        step: progress.step,
        message: outcome.problem.message,
        output: outcome.problem.output,
      });
    } else if (
      outcome.kind === "failed" &&
      (outcome.problem.kind === "hookFailed" ||
        outcome.problem.kind === "missingIdentity")
    )
      setRefusal(outcome.problem);
  }
  /** The undo entry's label, which holds the whole rebase. */
  const label =
    shown?.kind === "running" && shown.rebase
      ? `Rebase ${shown.rebase.branch} onto ${shown.rebase.onto}`
      : undefined;
  return (
    <>
      {progress && shown?.kind === "running" && (
        <OperationStrip
          key={shown.key}
          shown={shown}
          busy={busy}
          onInspect={onInspect}
          onFinish={async () => {
            if (progress.tree === null) return;
            await proceed(progress, {
              operation: {
                kind: "continueRebase",
                of: ofProgress(progress),
                staged: progress.staged,
                tree: progress.tree,
              },
              expect: { head: progress.head },
              label,
            });
          }}
          onSkip={() =>
            proceed(progress, {
              operation: {
                kind: "skipRebase",
                of: ofProgress(progress),
                staged: progress.staged,
              },
              expect: { head: progress.head },
              label,
            })
          }
          onAbort={async () => {
            setNotice(null);
            setStop(null);
            setRefusal(null);
            let result: ReplayAbortOutcome;
            try {
              result = await abort(root, ofProgress(progress), progress.head);
            } catch (error) {
              result = { kind: "failed", problem: problemFrom(error) };
            }
            setNotice(
              result.kind === "aborted"
                ? {
                    message:
                      "Rebase aborted. The branch is back where it was, its resolution Undo is closed, and earlier history is available again.",
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
        >
          {((stop && stop.step === progress.step && stop.output !== "") ||
            refusal) && (
            <div className="operation-detail">
              {stop && stop.step === progress.step && stop.output !== "" && (
                <div className="error-message commit-problem" role="alert">
                  <p>{stop.message}</p>
                  <pre className="problem-detail">{stop.output}</pre>
                </div>
              )}
              {refusal && commitOutput(refusal)}
            </div>
          )}
        </OperationStrip>
      )}
      {notice && (notice.error || !progress) && (
        <section className="merge-controls" aria-label="Rebase">
          <div
            role={notice.error ? "alert" : "status"}
            className={notice.error ? "error-message" : "muted"}
          >
            {notice.message}
          </div>
        </section>
      )}
    </>
  );
}
