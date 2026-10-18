import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  CloudAlert,
  CloudDownload,
  CloudOff,
  FolderGit2,
  GitFork,
  LoaderCircle,
  Minus,
  Plus,
  TriangleAlert,
} from "lucide-react";
import { attentionRows } from "../domain/overview";
import type {
  AdvanceOutcome,
  BranchRef,
  BranchStatus,
} from "../domain/overview";
import type { RecentRepository } from "../domain/recents";
import type { RepositoryRoot } from "../domain/repository";
import type { OverviewView, RepositoryState } from "../overview";

type Props = {
  view: OverviewView;
  entries: RecentRepository[];
  sidebarToggle: ReactNode;
  onFetch: () => void;
  onUpdateAll: () => void;
  onFastForward: (commonDir: RepositoryRoot, branch: BranchRef) => void;
  onOpen: (root: RepositoryRoot) => void;
  onAdd: () => void;
};

export function Overview({
  view,
  entries,
  sidebarToggle,
  onFetch,
  onUpdateAll,
  onFastForward,
  onOpen,
  onAdd,
}: Props) {
  const now = useNow(30_000);
  const pending = entries.filter(
    (entry) => view.roots.get(entry.root)?.kind !== "open",
  );

  return (
    <section className="overview" aria-labelledby="overview-heading">
      <header className="toolbar" data-tauri-drag-region>
        {sidebarToggle}
        <div className="breadcrumb" data-tauri-drag-region>
          <h1
            id="overview-heading"
            className="overview-title"
            data-tauri-drag-region
          >
            Overview
          </h1>
        </div>
        <div className="toolbar-actions">
          {entries.length > 0 && (
            <span className="overview-status" role="status">
              {view.fetching
                ? "Fetching…"
                : view.oldestFetchAt === null
                  ? ""
                  : fetchedLabel(view.oldestFetchAt, now)}
            </span>
          )}
          <button
            className="button secondary"
            disabled={view.fetching || entries.length === 0}
            onClick={onFetch}
            title="Download new commits from every saved repository's remotes."
          >
            {view.fetching ? (
              <LoaderCircle size={14} className="spin" />
            ) : (
              <CloudDownload size={14} />
            )}
            <span>Fetch</span>
          </button>
          <button
            className="button primary"
            disabled={view.readyCount === 0}
            onClick={onUpdateAll}
            title="Fast-forward every branch that is ready."
          >
            <ArrowDown size={14} />
            <span>
              Update all{view.readyCount > 0 ? ` (${view.readyCount})` : ""}
            </span>
          </button>
        </div>
      </header>
      {entries.length === 0 ? (
        <div className="workspace-empty">
          <div className="empty-icon">
            <FolderGit2 size={34} strokeWidth={1.3} />
          </div>
          <h1>No repositories yet</h1>
          <p>Add a working copy to see which branches fell behind.</p>
          <button className="button primary" onClick={onAdd}>
            <Plus size={16} />
            Add repository
          </button>
        </div>
      ) : (
        <div className="overview-list">
          {view.repositories.map((repository) => (
            <RepositoryCard
              key={repository.commonDir}
              repository={repository}
              onFastForward={onFastForward}
              onOpen={onOpen}
            />
          ))}
          {pending.map((entry) => {
            const state = view.roots.get(entry.root);
            return state?.kind === "unavailable" ? (
              <article
                className="overview-card"
                key={entry.root}
                aria-label={entry.name}
              >
                <CardHeader
                  name={entry.name}
                  roots={[entry.root]}
                  onOpen={onOpen}
                />
                <p className="overview-note warning" role="alert">
                  <TriangleAlert size={13} />
                  <span>{state.problem.message}</span>
                </p>
              </article>
            ) : (
              <article
                className="overview-card"
                key={entry.root}
                aria-label={entry.name}
              >
                <CardHeader
                  name={entry.name}
                  roots={[entry.root]}
                  onOpen={onOpen}
                  activity="Reading…"
                />
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function RepositoryCard({
  repository,
  onFastForward,
  onOpen,
}: {
  repository: RepositoryState;
  onFastForward: Props["onFastForward"];
  onOpen: Props["onOpen"];
}) {
  const { overview, activity, fetch, outcomes, commonDir } = repository;
  const { rows, hiddenUpToDate } = attentionRows(overview);
  const failures =
    fetch.kind === "fetched"
      ? fetch.remotes.flatMap(({ remote, outcome }) =>
          outcome.kind === "failed" ? [{ remote, ...outcome }] : [],
        )
      : [];

  return (
    <article className="overview-card" aria-label={overview.name}>
      <CardHeader
        name={overview.name}
        roots={repository.roots}
        onOpen={onOpen}
        activity={
          activity.kind === "fetching"
            ? "Fetching…"
            : activity.kind === "updating"
              ? "Updating…"
              : null
        }
      />
      {fetch.kind === "failed" && (
        <p className="overview-note warning" role="alert">
          <CloudAlert size={13} />
          <span>Could not fetch. {fetch.problem.message}</span>
        </p>
      )}
      {failures.map(({ remote, failure, message }) => (
        <p className="overview-note warning" key={remote} title={message}>
          <CloudAlert size={13} />
          <span>
            <strong>{remote}</strong> {failureLabel[failure]}. {message}
          </span>
        </p>
      ))}
      {rows.length > 0 && (
        <ul className="overview-rows">
          {rows.map((branch) => (
            <BranchRow
              key={branch.reference}
              branch={branch}
              outcome={outcomes.get(branch.reference) ?? null}
              busy={activity.kind !== "idle"}
              updating={
                activity.kind === "updating" &&
                activity.branches.has(branch.reference)
              }
              onFastForward={() => onFastForward(commonDir, branch.reference)}
            />
          ))}
        </ul>
      )}
      {hiddenUpToDate > 0 && (
        <p className="overview-more">
          {hiddenUpToDate === 1
            ? "1 more branch up to date"
            : `${hiddenUpToDate} more branches up to date`}
        </p>
      )}
    </article>
  );
}

function CardHeader({
  name,
  roots,
  onOpen,
  activity = null,
}: {
  name: string;
  roots: readonly RepositoryRoot[];
  onOpen: Props["onOpen"];
  activity?: string | null;
}) {
  const [primary] = roots;
  return (
    <header className="overview-card-header">
      <FolderGit2 size={15} />
      <div className="overview-card-title">
        <h2>{name}</h2>
        <span title={roots.join("\n")}>
          {primary}
          {roots.length === 2 && " · +1 worktree"}
          {roots.length > 2 && ` · +${roots.length - 1} worktrees`}
        </span>
      </div>
      {activity && (
        <span className="overview-activity">
          <LoaderCircle size={12} className="spin" />
          {activity}
        </span>
      )}
      {primary !== undefined && (
        <button
          className="button secondary compact"
          onClick={() => onOpen(primary)}
          aria-label={`Open ${name}`}
        >
          Open
        </button>
      )}
    </header>
  );
}

function BranchRow({
  branch,
  outcome,
  busy,
  updating,
  onFastForward,
}: {
  branch: BranchStatus;
  outcome: AdvanceOutcome | null;
  busy: boolean;
  updating: boolean;
  onFastForward: () => void;
}) {
  const { state } = branch;
  const ready = state.kind === "behind" && state.blocker === null;
  const notes: { text: string; tone: "muted" | "warning" | "success" }[] = [];
  if (branch.checkedOutAt !== null)
    notes.push({
      text: `Checked out in ${baseName(branch.checkedOutAt)}`,
      tone: "muted",
    });
  if (outcome !== null) notes.push(outcomeNote(outcome));
  else if (state.kind === "behind" && state.blocker !== null)
    notes.push({ text: blockerText(state.blocker), tone: "warning" });
  if (state.kind === "diverged")
    notes.push({
      text: "Diverged. L1 Git never merges or rebases.",
      tone: "warning",
    });
  const Icon = stateIcon[state.kind];

  return (
    <li className="overview-row">
      <div className="overview-row-text">
        <div className="overview-row-line">
          <Icon size={13} className={`overview-icon ${state.kind}`} />
          <span className="overview-branch">{branch.name}</span>
          {branch.role !== "other" && (
            <span className="overview-role">{branch.role}</span>
          )}
          <span className="overview-state">{stateText(branch)}</span>
        </div>
        {notes.length > 0 && (
          <div className="overview-row-notes">
            {notes.map(({ text, tone }) => (
              <span key={text} className={tone}>
                {text}
              </span>
            ))}
          </div>
        )}
      </div>
      {ready && (
        <button
          className="button secondary compact"
          disabled={busy}
          onClick={onFastForward}
          aria-label={`Fast-forward ${branch.name}`}
        >
          {updating ? (
            <LoaderCircle size={13} className="spin" />
          ) : (
            <ArrowDown size={13} />
          )}
          Fast-forward
        </button>
      )}
    </li>
  );
}

const failureLabel = {
  auth: "Authentication failed",
  network: "Network error",
  timedOut: "Timed out",
  busy: "Repository busy",
  other: "Fetch failed",
} as const;

const stateIcon = {
  behind: ArrowDown,
  diverged: GitFork,
  gone: CloudOff,
  ahead: ArrowUp,
  upToDate: Check,
  untracked: Minus,
} as const;

function stateText({ state }: BranchStatus): string {
  const commits = (count: number) =>
    count === 1 ? "1 commit" : `${count} commits`;
  switch (state.kind) {
    case "behind":
      return `Behind ${upstreamName(state.upstream)} by ${commits(state.behind)}`;
    case "diverged":
      return `${state.ahead} ahead, ${state.behind} behind ${upstreamName(state.upstream)}`;
    case "gone":
      return "Upstream deleted";
    case "ahead":
      return `Ahead of ${upstreamName(state.upstream)} by ${commits(state.ahead)}`;
    case "upToDate":
      return `Up to date with ${upstreamName(state.upstream)}`;
    case "untracked":
      return "No upstream";
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

type Blocker = NonNullable<
  Extract<BranchStatus["state"], { kind: "behind" }>["blocker"]
>;

function blockerText(blocker: Blocker): string {
  switch (blocker.kind) {
    case "dirty":
      return `Uncommitted changes in ${baseName(blocker.worktree)}. Commit or stash first.`;
    case "inUse":
      return `${baseName(blocker.worktree)} is in the middle of a merge, rebase, or other operation.`;
    case "unverified":
      return blocker.message;
    default: {
      const exhaustive: never = blocker;
      return exhaustive;
    }
  }
}

function outcomeNote(outcome: AdvanceOutcome): {
  text: string;
  tone: "warning" | "success";
} {
  if (outcome.kind === "advanced")
    return {
      text: `Fast-forwarded to ${outcome.to.slice(0, 7)}.`,
      tone: "success",
    };
  const { reason } = outcome;
  switch (reason.kind) {
    case "changed":
      return { text: "Moved since you fetched. Fetch again.", tone: "warning" };
    case "notBehind":
      return {
        text: "No longer behind its upstream. Fetch again.",
        tone: "warning",
      };
    case "dirty":
    case "inUse":
      return { text: blockerText(reason), tone: "warning" };
    case "failed":
      return { text: reason.message, tone: "warning" };
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

function upstreamName(upstream: string): string {
  return upstream.replace(/^refs\/remotes\//, "");
}

function baseName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function fetchedLabel(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return "Fetched just now";
  if (minutes < 60) return `Fetched ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours === 1 ? "Fetched 1 hour ago" : `Fetched ${hours} hours ago`;
}

function useNow(every: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const handle = window.setInterval(() => setNow(Date.now()), every);
    return () => window.clearInterval(handle);
  }, [every]);
  return now;
}
