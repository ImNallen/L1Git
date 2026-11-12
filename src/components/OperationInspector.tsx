import { useEffect, useState } from "react";
import { useCommitDraft } from "../commitDrafts";
import { splitMessage } from "../domain/commitMessage";
import {
  conflictLabel,
  operationMessage,
  operationWords,
} from "../domain/inProgress";
import type { InProgress } from "../domain/inProgress";
import type { MergeState } from "../domain/merge";
import type { RepositoryRoot } from "../domain/repository";
import { useDraftImpact } from "../draftProtection";
import * as repositories from "../repositories";
import { IncomingChip, SideChip } from "./OperationStrip";

type Running = Extract<InProgress, { kind: "running" }>;

const short = (oid: string | null) => (oid === null ? null : oid.slice(0, 7));

function explanation({ verb, current, subject }: Running): string {
  const moves = `${current.name === "Detached HEAD" ? "HEAD" : current.name} moves only when you finish.`;
  switch (verb) {
    case "merge":
      return `The merge commit gets both as parents. ${moves}`;
    case "cherryPick":
      return `Finish adds one commit with the changes from “${subject ?? ""}”. ${moves}`;
    case "revert":
      return `Finish adds one commit that undoes “${subject ?? ""}”. ${moves}`;
  }
}

export function OperationOverview({ running }: { running: Running }) {
  const { current, incoming, verb } = running;
  return (
    <section className="operation-overview" aria-label="Sides">
      <dl className="operation-sides">
        <div>
          <dt>Into</dt>
          <dd>
            <SideChip side="current">{current.name}</SideChip>
            {current.oid !== null && <code>{short(current.oid)}</code>}
          </dd>
        </div>
        <div>
          <dt>From</dt>
          <dd>
            {verb === "merge" ? (
              <>
                <SideChip side="incoming">{incoming.name}</SideChip>
                <code>{short(incoming.oid)}</code>
              </>
            ) : (
              <IncomingChip running={running} />
            )}
          </dd>
        </div>
      </dl>
      <p>{explanation(running)}</p>
    </section>
  );
}

export function useConflictLabels(
  root: RepositoryRoot,
  state: MergeState | null,
  unresolved: number,
): ReadonlyMap<string, string> | null {
  const [labels, setLabels] = useState<{
    root: RepositoryRoot;
    labels: ReadonlyMap<string, string>;
  } | null>(null);
  useEffect(() => {
    if (unresolved === 0) return;
    let current = true;
    repositories.conflictSummary(root).then(
      (summary) => {
        if (current)
          setLabels({
            root,
            labels: new Map(
              summary.map((entry) => [entry.path, conflictLabel(entry)]),
            ),
          });
      },
      () => {
        if (current) setLabels(null);
      },
    );
    return () => {
      current = false;
    };
  }, [root, state, unresolved]);
  return labels?.root === root ? labels.labels : null;
}

export function OperationMessage({ running }: { running: Running }) {
  const { root, verb, suggestedMessage } = running;
  const [current, setDraft] = useCommitDraft(root);
  const { draft, amend } = current;
  const { frozen } = useDraftImpact();
  const { edited } = operationMessage(running, draft);
  const suggested = splitMessage(suggestedMessage);
  const base = edited ? draft : suggested;
  const { noun } = operationWords[verb];
  if (amend && verb !== "merge")
    return (
      <section className="operation-message" aria-label="Commit message">
        <h3>Commit message</h3>
        <p role="status">
          Amend is on for this worktree. Turn it off to write the message for
          this {noun}. Your earlier draft comes back.
        </p>
        <button
          className="button secondary"
          disabled={frozen}
          onClick={() => setDraft({ draft: amend.draftAside, amend: null })}
        >
          Turn off Amend
        </button>
      </section>
    );
  return (
    <section className="operation-message" aria-label="Commit message">
      <header>
        <h3>Commit message</h3>
        {edited ? (
          <button
            className="operation-message-hint"
            disabled={frozen}
            title="Use the suggested message"
            onClick={() =>
              setDraft({
                draft: { summary: "", description: "" },
                amend: null,
              })
            }
          >
            Edited · Use suggested
          </button>
        ) : (
          <span className="operation-message-hint">Suggested</span>
        )}
      </header>
      <input
        aria-label={verb === "merge" ? "Merge commit message" : "Summary"}
        className={`commit-summary${edited ? "" : " suggested"}`}
        value={draft.summary}
        placeholder={suggested.summary}
        autoComplete="off"
        spellCheck
        readOnly={frozen}
        onChange={(event) =>
          setDraft({
            draft: { ...base, summary: event.target.value },
            amend: null,
          })
        }
      />
      <textarea
        aria-label={verb === "merge" ? "Merge description" : "Description"}
        className={`commit-description${!edited && suggested.description !== "" ? " suggested" : ""}`}
        value={draft.description}
        placeholder={
          !edited && suggested.description !== ""
            ? suggested.description
            : "Description (optional)"
        }
        rows={3}
        spellCheck
        readOnly={frozen}
        onChange={(event) =>
          setDraft({
            draft: { ...base, description: event.target.value },
            amend: null,
          })
        }
      />
    </section>
  );
}

export function undoNote({ verb, phase }: Running): string {
  if (phase === "empty")
    return "Each resolution has Undo until you abort. Abort cannot be undone.";
  return verb === "merge"
    ? "Each resolution has Undo until you finish. Finish and Abort cannot be undone."
    : "Each resolution has Undo until you finish. Finish can be undone like a commit, which does not reopen the conflict. Abort cannot be undone.";
}
