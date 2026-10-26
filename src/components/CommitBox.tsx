import { useEffect, useState } from "react";
import type { KeyboardEvent } from "react";
import { LoaderCircle, TriangleAlert } from "lucide-react";
import * as repositories from "../repositories";
import { amendsHead, clearSubmitted, useCommitDraft } from "../commitDrafts";
import {
  identityCommands,
  loadMessage,
  messageFor,
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

export const submits = (event: KeyboardEvent) =>
  event.key === "Enter" && (event.metaKey || event.ctrlKey);

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
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const amending = amend !== null;
  const stale = amend !== null && !amendsHead(current, head);
  useEffect(() => {
    if (!stale) return;
    setDraft({ draft: amend.draftAside, amend: null });
    setProblem({
      kind: "staleView",
      reason: "headMoved",
      message:
        "HEAD moved since L1 Git loaded its message, so Amend is off again and your draft is back.",
    });
  }, [stale, amend, setDraft]);
  const ready =
    draft.summary.trim() !== "" &&
    (staged > 0 || amending) &&
    !busy &&
    !loading &&
    !submitting;

  async function toggleAmend(checked: boolean) {
    setProblem(null);
    if (!checked) {
      if (amend) setDraft({ draft: amend.draftAside, amend: null });
      return;
    }
    if (head.kind === "unborn") return;
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
    }
  }

  async function submit() {
    if (!ready || stale) return;
    const sent = current;
    const kind = !amending ? "commit" : staged > 0 ? "amend" : "editMessage";
    const message = messageFor(draft, amend?.loaded ?? null);
    setSubmitting(true);
    setProblem(null);
    const outcome = await onCommit(root, commitWrite(kind, status, message));
    setSubmitting(false);
    if (outcome.kind === "busy") return;
    if (outcome.kind === "applied") {
      clearSubmitted(root, sent);
      return;
    }
    const { problem } = outcome;
    if (problem.kind === "raced") clearSubmitted(root, sent);
    if (problem.kind === "hookFailed" || problem.kind === "missingIdentity")
      setProblem(problem);
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (!submits(event)) return;
    event.preventDefault();
    void submit();
  };
  const action = amending ? "Amend" : "Commit";
  const hint =
    draft.summary.trim() === ""
      ? "Write a summary first."
      : staged === 0 && !amending
        ? "Stage a file first, or amend the previous commit."
        : `${action} (${repositories.mac ? "⌘" : "Ctrl+"}Enter)`;
  return (
    <form
      className="commit-box"
      aria-label="Commit"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <input
        id={COMMIT_SUMMARY_ID}
        className="commit-summary"
        aria-label="Summary"
        placeholder={amending ? "Summary of the amended commit" : "Summary"}
        autoComplete="off"
        spellCheck
        value={draft.summary}
        disabled={loading}
        onChange={(event) =>
          setDraft({ draft: { ...draft, summary: event.target.value }, amend })
        }
        onKeyDown={onKeyDown}
      />
      <textarea
        className="commit-description"
        aria-label="Description"
        placeholder="Description"
        rows={3}
        spellCheck
        value={draft.description}
        disabled={loading}
        onChange={(event) =>
          setDraft({
            draft: { ...draft, description: event.target.value },
            amend,
          })
        }
        onKeyDown={onKeyDown}
      />
      <div className="commit-actions">
        <label className="commit-amend">
          <input
            type="checkbox"
            checked={amending}
            disabled={head.kind === "unborn" || loading || submitting}
            onChange={(event) => void toggleAmend(event.target.checked)}
          />
          Amend previous commit
        </label>
        <button
          type="submit"
          className="button primary"
          disabled={!ready}
          title={hint}
        >
          {submitting || loading ? (
            <LoaderCircle size={14} className="spin" />
          ) : null}
          {action}
        </button>
      </div>
      {problem && <CommitProblem problem={problem} />}
    </form>
  );
}

function CommitProblem({ problem }: { problem: Problem }) {
  const output = "output" in problem ? problem.output : "";
  const commands =
    problem.kind === "missingIdentity" ? identityCommands(output) : [];
  if (problem.kind === "hookFailed")
    return (
      <div className="error-message commit-problem">
        <p>The hook printed:</p>
        <pre className="problem-detail">{output || "Nothing."}</pre>
      </div>
    );
  if (commands.length > 0)
    return (
      <div className="error-message commit-problem">
        <p>Set your name and email, then commit again:</p>
        <pre className="problem-detail">{commands.join("\n")}</pre>
      </div>
    );
  return (
    <div className="error-message commit-problem" role="alert">
      <p>
        <TriangleAlert size={14} />
        <span>{problem.message}</span>
      </p>
    </div>
  );
}
