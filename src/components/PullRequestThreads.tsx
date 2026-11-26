import { useId, useState } from "react";
import { ChevronRight, CircleCheck, Folder, MessageSquare } from "lucide-react";
import { counted, personName } from "../domain/pullRequestDetail";
import type { ReviewThread } from "../domain/pullRequest";
import { threadFilters, threadsView } from "../domain/threadStanding";
import type {
  Standing,
  ThreadFilter,
  ThreadRow,
} from "../domain/threadStanding";
import { useThreadWaits } from "./conversationWriting";
import { Ago, Avatar } from "./PullRequestParts";
import { ThreadBody, useFold } from "./PullRequestThread";

const standingLabels: Record<Standing | ThreadFilter, string> = {
  open: "Open",
  waitingOnYou: "Waiting on you",
  outdated: "Outdated",
  resolved: "Resolved",
};

const nothing: Record<ThreadFilter, string> = {
  open: "No thread is open.",
  waitingOnYou: "No thread waits on you.",
  outdated: "No thread shows as outdated.",
  resolved: "No thread is resolved.",
};

export function ThreadFilters({
  counts,
  filter,
  onFilter,
}: {
  counts: Record<ThreadFilter, number>;
  filter: ThreadFilter;
  onFilter: (filter: ThreadFilter) => void;
}) {
  return (
    <div className="thread-filters" role="group" aria-label="Show threads">
      {threadFilters.map((each) => (
        <button
          key={each}
          type="button"
          className={each}
          aria-pressed={each === filter}
          onClick={() => onFilter(each)}
        >
          {standingLabels[each]}
          <span className="thread-filter-count">
            {counts[each].toLocaleString()}
          </span>
        </button>
      ))}
    </div>
  );
}

function Row({
  row: { thread, standing, place, by, words, replies, at },
  viewer,
  url,
  onShowInDiff,
  onAct,
}: {
  row: ThreadRow;
  viewer: string;
  url: string;
  onShowInDiff: (path: string) => void;
  onAct: (thread: string) => void;
}) {
  const fold = useFold(thread.resolved);
  const [opened, setOpened] = useState(false);
  const [was, setWas] = useState(fold.expanded);
  // Folding a resolved thread folds its row too.
  if (was !== fold.expanded) {
    setWas(fold.expanded);
    if (!fold.expanded) setOpened(false);
  }
  const content = useId();
  // A write that waits here stays in sight.
  const waits = useThreadWaits(thread.id);
  const shown = opened || waits;
  return (
    <li className="threads-row">
      <button
        ref={fold.toggle}
        type="button"
        className="threads-row-head"
        aria-expanded={shown}
        aria-controls={content}
        onClick={() => setOpened(!shown)}
      >
        <ChevronRight size={14} aria-hidden="true" />
        <span className="threads-place">{place}</span>
        <Avatar login={by} />
        <strong>{personName(by, viewer)}</strong>
        <span className="threads-words" dir="auto">
          {words}
        </span>
        {replies > 0 && (
          <span
            className="threads-replies"
            title={counted(replies, "reply", "replies")}
          >
            <MessageSquare size={13} aria-hidden="true" />
            <span className="visually-hidden">
              {counted(replies, "reply", "replies")}
            </span>
            <span aria-hidden="true">{replies.toLocaleString()}</span>
          </span>
        )}
        <span className={`threads-pill ${standing}`}>
          {standingLabels[standing]}
        </span>
        {at !== null && (
          <span className="threads-age">
            <Ago at={at} />
          </span>
        )}
      </button>
      <div id={content} className="threads-row-body" hidden={!shown}>
        {shown && (
          <ThreadBody
            thread={thread}
            viewer={viewer}
            url={url}
            short
            onShowInDiff={onShowInDiff}
            onAct={(kind) => {
              fold.onAct(kind);
              onAct(thread.id);
            }}
          />
        )}
      </div>
    </li>
  );
}

/**
 * Every review thread, by file, one row each. A row opens to its lines and
 * comments, Reply, Show in diff and Resolve. A thread acted on stays in its
 * place until the filter changes.
 */
export function PullRequestThreads({
  threads,
  viewer,
  url,
  filter,
  onFilter,
  onShowInDiff,
}: {
  threads: readonly ReviewThread[];
  viewer: string;
  url: string;
  filter: ThreadFilter;
  onFilter: (filter: ThreadFilter) => void;
  onShowInDiff: (path: string) => void;
}) {
  const [kept, setKept] = useState<ReadonlySet<string>>(new Set());
  const { groups, hidden } = threadsView(threads, viewer, filter, kept);
  const act = (id: string) => setKept((before) => new Set(before).add(id));
  return (
    <div className="threads">
      {groups.length === 0 && (
        <p className="threads-nothing">{nothing[filter]}</p>
      )}
      {groups.map(({ path, rows }) => (
        <section key={path} className="threads-file" aria-label={path}>
          <h3 className="threads-path">
            <Folder size={13} aria-hidden="true" />
            <bdi>{path}</bdi>
            <span>{rows.length.toLocaleString()}</span>
          </h3>
          <ul>
            {rows.map((row) => (
              <Row
                key={row.thread.id}
                row={row}
                viewer={viewer}
                url={url}
                onShowInDiff={onShowInDiff}
                onAct={act}
              />
            ))}
          </ul>
        </section>
      ))}
      {hidden > 0 && (
        <p className="threads-hidden">
          <CircleCheck size={14} aria-hidden="true" />
          {counted(hidden, "resolved thread")} {hidden === 1 ? "is" : "are"}{" "}
          hidden.
          <button
            type="button"
            className="pull-link"
            onClick={() => onFilter("resolved")}
          >
            Show them
          </button>
        </p>
      )}
    </div>
  );
}
