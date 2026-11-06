import { useState } from "react";
import { GitCommitHorizontal } from "lucide-react";
import { clearSubmitted, useCommitDraft } from "../commitDrafts";
import { messageFor } from "../domain/commitMessage";
import { replayNames } from "../domain/merge";
import type { MergeState, ReplayProgress } from "../domain/merge";
import { problemFrom } from "../domain/repository";
import type { Head, ReplayOf, RepositoryRoot } from "../domain/repository";
import type { Write } from "../domain/operations";
import { useDraftImpact } from "../draftProtection";
import {
  discardConsentedResolutions,
  resolutionConsent,
} from "../resolutionDrafts";
import type { Read } from "../useRead";
import type { Outcome, ReplayAbortOutcome } from "../useWrites";
import { ConfirmDialog } from "./ConfirmDialog";
import { OperationMessage } from "./MergeControls";

type Notice = { message: string; error: boolean };

export function ReplayPanel({
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
    of: ReplayOf,
    head: Head,
  ) => Promise<ReplayAbortOutcome>;
  onInspect: () => void;
}) {
  const [notice, setNotice] = useState<Notice | null>(null);
  const progress =
    read.kind === "ready" && read.value.kind === "replay"
      ? read.value.progress
      : null;
  if (!progress && !notice) return null;
  return (
    <section className="merge-controls" aria-label="Cherry-pick or revert">
      {notice && (notice.error || !progress) && (
        <div
          role={notice.error ? "alert" : "status"}
          className={notice.error ? "error-message" : "muted"}
        >
          {notice.message}
        </div>
      )}
      {progress && (
        <ActiveReplay
          key={`${progress.kind}:${progress.commit}`}
          progress={progress}
          busy={busy}
          write={(request) => {
            setNotice(null);
            return write(root, request);
          }}
          abort={async () => {
            setNotice(null);
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
            return result;
          }}
          onInspect={onInspect}
        />
      )}
    </section>
  );
}

function ActiveReplay({
  progress,
  busy,
  write,
  abort,
  onInspect,
}: {
  progress: ReplayProgress;
  busy: boolean;
  write: (write: Write) => Promise<Outcome>;
  abort: () => Promise<ReplayAbortOutcome>;
  onInspect: () => void;
}) {
  const { root, kind, commit, subject, destination, unresolved, tree, empty } =
    progress;
  const { noun, title } = replayNames[kind];
  const [draft, setDraft] = useCommitDraft(root);
  const { amend } = draft;
  const impact = useDraftImpact();
  const [aborting, setAborting] = useState<ReturnType<
    typeof resolutionConsent
  > | null>(null);
  const message = messageFor(draft.draft, null);
  const dirty = impact.resolutions.some((draft) => draft.root === root);
  const disabled = busy || impact.frozen;
  const ready =
    !disabled &&
    !dirty &&
    amend === null &&
    tree !== null &&
    unresolved.length === 0 &&
    message.trim() !== "";
  async function finish() {
    if (!ready || tree === null) return;
    const outcome = await write({
      operation: {
        kind: "finishReplay",
        of: { kind, commit },
        staged: progress.staged,
        tree,
        message,
      },
      expect: { head: destination },
    });
    if (
      outcome.kind === "applied" ||
      (outcome.kind === "failed" &&
        (outcome.problem.kind === "raced" ||
          outcome.problem.kind === "afterHookFailed"))
    )
      clearSubmitted(root, draft);
  }
  return (
    <>
      <strong>{title} in progress</strong>
      <dl className="merge-pair">
        <dt>Commit</dt>
        <dd>
          {subject}
          <code>{commit}</code>
        </dd>
        <dt>Destination</dt>
        <dd>
          {destination.kind === "detached"
            ? "Detached HEAD"
            : destination.reference}
          {destination.kind !== "unborn" && <code>{destination.oid}</code>}
        </dd>
      </dl>
      <p>
        {empty
          ? `The staged result matches HEAD, so there is nothing to commit. Abort ends the ${noun} and keeps every commit.`
          : unresolved.length
            ? `${unresolved.length} unresolved path${unresolved.length === 1 ? "" : "s"}. Resolve and mark each path.`
            : "All conflicts are resolved. Review the staged result before finishing."}
      </p>
      <button className="button secondary" onClick={onInspect}>
        Review staged result and conflicts
      </button>
      {!empty &&
        (amend ? (
          <>
            <p role="status">
              Amend is on for this worktree. Turn it off to write the message
              for this {noun}. Your earlier draft comes back.
            </p>
            <button
              className="button secondary"
              disabled={disabled}
              onClick={() => setDraft({ draft: amend.draftAside, amend: null })}
            >
              Turn off Amend
            </button>
          </>
        ) : (
          <OperationMessage
            summaryLabel="Commit message"
            descriptionLabel="Commit description"
            suggested={progress.suggestedMessage}
            draft={draft.draft}
            setDraft={(next) => setDraft({ draft: next, amend: null })}
            disabled={disabled}
          />
        ))}
      {dirty && (
        <p role="status">
          Unsaved conflict results must be saved before Finish. Abort asks
          before discarding the drafts shown when you confirm.
        </p>
      )}
      <div className="merge-actions">
        {!empty && (
          <button
            className="button primary"
            disabled={!ready}
            onClick={() => void finish()}
          >
            Finish {noun}
          </button>
        )}
        <button
          className="button secondary"
          disabled={disabled}
          onClick={() =>
            setAborting(resolutionConsent(root, progress.footprint))
          }
        >
          Abort {noun}…
        </button>
      </div>
      <p className="muted">
        {!empty &&
          "Finish can be undone like a commit. Undo removes the commit and its file changes, and it does not reopen the conflict. "}
        Abort cannot be undone. Resolution edits have Undo and Redo until{" "}
        {empty ? "Abort" : "Finish or Abort"}.
      </p>
      {aborting && (
        <ConfirmDialog
          icon={GitCommitHorizontal}
          title={`Abort this ${noun}?`}
          closeLabel={`Close abort ${noun}`}
          confirm={`Discard ${noun} and abort`}
          onClose={() => setAborting(null)}
          onConfirm={() => {
            if (disabled) return;
            void abort().then((result) => {
              if (result.kind === "aborted")
                discardConsentedResolutions(aborting);
            });
          }}
        >
          <p>
            Discard the {noun} result and saved resolutions in its affected
            paths. A staged change outside those paths blocks Abort. Untracked
            and ignored files stay.
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
