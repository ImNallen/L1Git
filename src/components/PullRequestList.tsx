import {
  CircleCheck,
  CircleDashed,
  CircleX,
  MessageSquare,
} from "lucide-react";
import { initials } from "../domain/author";
import {
  addedSegments,
  authorName,
  changeSegments,
  checksOf,
  pullRequestUrl,
  reviewLabels,
  reviewPill,
  rowState,
  rowTime,
  stateLabels,
} from "../domain/pullRequestList";
import type { Group, ListedRepository, Row } from "../domain/pullRequestList";
import type { PullRequestSummary } from "../domain/pullRequest";
import { shortRelativeTime } from "../domain/time";
import { formatChangeCount } from "../historyColumns";
import { PullRequestIcon } from "./PullRequestIcon";

const plainName = (login: string) => login.replace(/\[bot\]$/, "");

const checkIcons = {
  passed: CircleCheck,
  failing: CircleX,
  running: CircleDashed,
};

function ChecksCell({ pull }: { pull: PullRequestSummary }) {
  const { kind, label } = checksOf(pull);
  const Icon = kind === "none" || kind === "noAccess" ? null : checkIcons[kind];
  return (
    <span
      className={`pull-checks ${kind}`}
      title={
        kind === "noAccess" ? "This sign-in can't read its checks." : undefined
      }
    >
      {Icon && <Icon size={14} />}
      <span>{label}</span>
    </span>
  );
}

function Changes({ pull }: { pull: PullRequestSummary }) {
  const { additions, deletions } = pull;
  const added = addedSegments(pull);
  return (
    <span className="pull-changes">
      <span className="change-stat added">+{formatChangeCount(additions)}</span>
      <span className={`change-stat deleted${deletions === 0 ? " zero" : ""}`}>
        {"−"}
        {formatChangeCount(deletions)}
      </span>
      <span className="pull-bar">
        {Array.from({ length: changeSegments }, (_, index) => (
          <i
            key={index}
            className={
              added === null ? "" : index < added ? "added" : "deleted"
            }
          />
        ))}
      </span>
    </span>
  );
}

function rowName(repository: ListedRepository, pull: PullRequestSummary) {
  const pill = reviewPill(pull);
  const checks = checksOf(pull);
  const state = rowState(pull);
  return [
    pull.title,
    `#${pull.number} in ${repository.name}`,
    `by ${authorName(pull)}`,
    stateLabels[state],
    pill && pill !== state ? reviewLabels[pill] : null,
    checks.kind === "none" ? "no checks" : `checks ${checks.label}`,
    pull.labels.items.length > 0
      ? `labels ${pull.labels.items.map(({ name }) => name).join(" ")}`
      : null,
  ]
    .filter((part) => part !== null)
    .join(", ");
}

function PullRequestRow({ row: { repository, pull } }: { row: Row }) {
  const state = rowState(pull);
  const pill = reviewPill(pull);
  const author = authorName(pull);
  const time = rowTime(pull);
  const changed = new Date(time);
  return (
    <a
      className={`pull-row ${state}`}
      href={pullRequestUrl(repository.github, pull.number)}
      target="_blank"
      rel="noreferrer"
      aria-label={rowName(repository, pull)}
    >
      <PullRequestIcon state={state} />
      <span className="pull-summary">
        <span className="pull-title">
          <span className="pull-title-text" title={pull.title}>
            {pull.title}
          </span>
          <span className="pull-labels">
            {pull.labels.items.map(({ name }) => (
              <span className="pull-label" key={name} title={name}>
                {name}
              </span>
            ))}
          </span>
        </span>
        <span className="pull-meta">
          <span className="pull-meta-repository">{repository.name}</span>
          <span>#{pull.number}</span>
          <span
            className="pull-branches"
            title={`${pull.head} into ${pull.base}`}
          >
            {pull.head} → {pull.base}
          </span>
          {pull.comments > 0 && (
            <span
              className="pull-comments"
              title={`${pull.comments.toLocaleString()} ${pull.comments === 1 ? "comment" : "comments"}`}
            >
              <MessageSquare size={11} />
              {pull.comments.toLocaleString()}
            </span>
          )}
        </span>
      </span>
      <span className="pull-repository" title={repository.name}>
        {repository.name}
      </span>
      <span className="pull-author" title={author}>
        <span className="pull-avatar">{initials(plainName(author))}</span>
        <span>{author}</span>
      </span>
      <span className="pull-review">
        {pill && (
          <span className={`pull-pill ${pill}`}>{reviewLabels[pill]}</span>
        )}
      </span>
      <ChecksCell pull={pull} />
      <Changes pull={pull} />
      <time
        className="pull-time"
        dateTime={time}
        title={changed.toLocaleString()}
      >
        {shortRelativeTime(changed.getTime() / 1_000)}
      </time>
    </a>
  );
}

/** The head is for the eye. Each row's own name says what its columns hold. */
export function PullRequestColumns({ merged }: { merged: boolean }) {
  return (
    <div className="pull-columns" aria-hidden="true">
      <span />
      <span>Pull request</span>
      <span className="pull-repository">Repository</span>
      <span className="pull-author">Author</span>
      <span>Review</span>
      <span>Checks</span>
      <span className="pull-changes">Changes</span>
      <span>{merged ? "Merged" : "Updated"}</span>
    </div>
  );
}

export function PullRequestGroups({ groups }: { groups: readonly Group[] }) {
  return groups.map(({ repository, rows, cut }) => (
    <section
      key={repository?.key ?? ""}
      className="pull-group"
      aria-label={repository?.name}
    >
      {repository && (
        <h3 className="pull-group-heading">
          {repository.name}
          <span>{rows.length.toLocaleString()}</span>
        </h3>
      )}
      <ul className="pull-rows" aria-label="Pull requests">
        {rows.map((row) => (
          <li key={row.key}>
            <PullRequestRow row={row} />
          </li>
        ))}
      </ul>
      {cut !== null && <p className="pull-note">{cut}</p>}
    </section>
  ));
}

export function PullRequestSkeleton() {
  return (
    <div className="pull-skeleton" aria-hidden="true">
      {Array.from({ length: 16 }, (_, index) => (
        <div className="pull-row" key={index}>
          <i className="dot" />
          <span className="pull-summary">
            <i className="long" />
            <i className="short" />
          </span>
          <span className="pull-repository">
            <i />
          </span>
          <span className="pull-author">
            <i className="dot" />
            <i />
          </span>
          <span className="pull-review">
            <i className="pill" />
          </span>
          <i />
          <span className="pull-changes">
            <i />
          </span>
          <i className="tiny" />
        </div>
      ))}
    </div>
  );
}
