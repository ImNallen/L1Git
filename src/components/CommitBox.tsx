import { useEffect, useState } from "react";
import type { KeyboardEvent } from "react";
import { LoaderCircle, TriangleAlert } from "lucide-react";
import * as repositories from "../repositories";
import {
  amendsHead,
  beginDraftTask,
  clearSubmitted,
  useCommitDraft,
  useDraftImpact,
} from "../commitDrafts";
import {
  identityCommands,
  loadMessage,
  messageFor,
  submitsMessage,
} from "../domain/commitMessage";
import { singleCommit } from "../domain/comparison";
import { commitWrite } from "../domain/operations";
import type { Write } from "../domain/operations";
import { problemFrom } from "../domain/repository";
import type {
  Oid,
  Problem,
  RepositoryRoot,
  WorktreeStatus,
} from "../domain/repository";
import type { Outcome } from "../useWrites";

export async function commitMessage(root: RepositoryRoot, oid: Oid) {
  const detail = await repositories.commitDetail(root, singleCommit(oid));
  return detail.target.kind === "commit" ? detail.target.message : "";
}

export const COMMIT_SUMMARY_ID = "commit-summary";

export const messageKeys = (submit: () => void) => (event: KeyboardEvent) => {
  if (!submitsMessage(event.nativeEvent)) return;
  event.preventDefault();
  submit();
};

export function CommitBox({
  status,
  staged,
  busy,
  onCommit,
}: {
  status: WorktreeStatus;
  staged: number;
  busy: boolean;
  onCommit: (worktree: RepositoryRoot, write: Write) => Promise<Outcome>;
}) {
  const { root, head } = status;
  const [current, setDraft] = useCommitDraft(root);
  const { draft, amend } = current;
  const { frozen } = useDraftImpact();
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const amending = amend !== null;
  const stale = amend !== null && !amendsHead(current, head);
  useEffect(() => {
    if (!stale || frozen) return;
    setDraft({ draft: amend.draftAside, amend: null });
    setProblem({
      kind: "staleView",
      reason: "headMoved",
      message:
        "HEAD moved since L1 Git loaded its message, so Amend is off again and your draft is back.",
    });
  }, [stale, amend, setDraft, frozen]);
  const ready =
    draft.summary.trim() !== "" &&
    (staged > 0 || amending) &&
    !busy &&
    !loading &&
    !submitting &&
    !frozen;

  async function toggleAmend(checked: boolean) {
    if (loading || submitting || frozen) return;
    setProblem(null);
    if (!checked) {
      if (amend) setDraft({ draft: amend.draftAside, amend: null });
      return;
    }
    if (head.kind === "unborn") return;
    const finishDraftTask = beginDraftTask();
    if (!finishDraftTask) return;
    setLoading(true);
    try {
      const loaded = loadMessage(await commitMessage(root, head.oid));
      setDraft({
        draft: loaded.draft,
        amend: { draftAside: draft, loaded, head: head.oid },
      });
    } catch (error) {
      setProblem(problemFrom(error));
    } finally {
      setLoading(false);
      finishDraftTask();
    }
  }

  async function submit() {
    if (!ready || stale) return;
    const finishDraftTask = beginDraftTask();
    if (!finishDraftTask) return;
    try {
      const sent = current;
      const kind = !amending ? "commit" : staged > 0 ? "amend" : "editMessage";
      const message = messageFor(draft, amend?.loaded ?? null);
      setSubmitting(true);
      setProblem(null);
      const outcome = await onCommit(root, commitWrite(kind, status, message));
      if (outcome.kind === "busy") return;
      if (outcome.kind === "applied") {
        clearSubmitted(root, sent);
        return;
      }
      const { problem } = outcome;
      if (problem.kind === "raced") clearSubmitted(root, sent);
      if (problem.kind === "hookFailed" || problem.kind === "missingIdentity")
        setProblem(problem);
    } finally {
      setSubmitting(false);
      finishDraftTask();
    }
  }

  const keys = messageKeys(() => void submit());
  const action = amending ? "Amend" : "Commit";
  const hint =
    draft.summary.trim() === ""
      ? "Write a summary first."
      : staged === 0 && !amending
        ? "Stage a file first, or amend the previous commit."
        : `${action} (${repositories.mac ? "⌘" : "Ctrl+"}Enter)`;
  return (
    <div className="commit-box" role="group" aria-label="Commit">
      <input
        id={COMMIT_SUMMARY_ID}
        className="commit-summary"
        aria-label="Summary"
        placeholder={amending ? "Summary of the amended commit" : "Summary"}
        autoComplete="off"
        spellCheck
        value={draft.summary}
        readOnly={loading || frozen}
        onChange={(event) =>
          setDraft({ draft: { ...draft, summary: event.target.value }, amend })
        }
        onKeyDown={keys}
      />
      <textarea
        className="commit-description"
        aria-label="Description"
        placeholder="Description"
        rows={3}
        spellCheck
        value={draft.description}
        readOnly={loading || frozen}
        onChange={(event) =>
          setDraft({
            draft: { ...draft, description: event.target.value },
            amend,
          })
        }
        onKeyDown={keys}
      />
      <div className="commit-actions">
        <label className="commit-amend">
          <input
            type="checkbox"
            checked={amending}
            disabled={head.kind === "unborn" || frozen}
            aria-disabled={loading || submitting || frozen}
            onChange={(event) => void toggleAmend(event.target.checked)}
          />
          Amend previous commit
        </label>
        <button
          type="button"
          className="button primary"
          aria-disabled={!ready}
          title={hint}
          onClick={() => void submit()}
        >
          {submitting || loading ? (
            <LoaderCircle size={14} className="spin" />
          ) : null}
          {action}
        </button>
      </div>
      {problem &&
        (commitOutput(problem) ?? (
          <div className="error-message commit-problem" role="alert">
            <p>
              <TriangleAlert size={14} />
              <span>{problem.message}</span>
            </p>
          </div>
        ))}
    </div>
  );
}

export function commitOutput(problem: Problem) {
  const output = "output" in problem ? problem.output : "";
  if (problem.kind === "hookFailed")
    return (
      <div className="error-message commit-problem">
        <p>The hook printed:</p>
        <pre className="problem-detail">{output || "Nothing."}</pre>
      </div>
    );
  const commands =
    problem.kind === "missingIdentity" ? identityCommands(output) : [];
  if (commands.length === 0) return null;
  return (
    <div className="error-message commit-problem">
      <p>Set your name and email, then try again:</p>
      <pre className="problem-detail">{commands.join("\n")}</pre>
    </div>
  );
}
