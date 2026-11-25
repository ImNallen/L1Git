import { memo, useId, useState } from "react";
import { ChevronDown, MessageSquare } from "lucide-react";
import type { ReviewThread } from "../domain/pullRequest";
import { lineLabel } from "../domain/pullRequestDetail";
import { chipOf, elsewhereLabel } from "../domain/reviewThreads";
import { Avatar } from "./PullRequestParts";
import { Thread, ThreadComments } from "./PullRequestThread";

/** A thread in one row, which unfolds. */
export const ThreadChip = memo(function ThreadChip({
  thread,
  viewer,
  url,
  open,
  onToggle,
}: {
  thread: ReviewThread;
  viewer: string;
  url: string;
  open: boolean;
  onToggle: (thread: string) => void;
}) {
  const content = useId();
  const { people, count, by, words } = chipOf(thread, viewer);
  return (
    <section className="thread-chip" aria-label="Thread">
      <button
        type="button"
        className="thread-chip-row"
        aria-expanded={open}
        aria-controls={content}
        onClick={() => onToggle(thread.id)}
      >
        <span className="thread-chip-people">
          {people.map((login) => (
            <Avatar key={login} login={login} />
          ))}
        </span>
        <strong>{count}</strong>
        <span className="thread-chip-words">
          {by !== null && (
            <>
              <bdi>{by}</bdi>
              {words !== "" && (
                <>
                  : “<bdi>{words}</bdi>”
                </>
              )}
            </>
          )}
        </span>
        {thread.startLine !== null && thread.startLine !== thread.line && (
          <span className="thread-chip-lines">{lineLabel(thread)}</span>
        )}
        {thread.resolved && <span className="thread-resolved">Resolved</span>}
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      <div id={content} hidden={!open}>
        {open && <ThreadComments thread={thread} viewer={viewer} url={url} />}
      </div>
    </section>
  );
});

/** The threads of a file that have no line in what is shown of it. */
export function ThreadsElsewhere({
  threads,
  viewer,
  url,
}: {
  threads: readonly ReviewThread[];
  viewer: string;
  url: string;
}) {
  const [open, setOpen] = useState(false);
  const content = useId();
  return (
    <section className="threads-elsewhere" aria-label="Other comments">
      <button
        type="button"
        className="threads-elsewhere-row"
        aria-expanded={open}
        aria-controls={content}
        onClick={() => setOpen(!open)}
      >
        <MessageSquare size={14} aria-hidden="true" />
        {elsewhereLabel(threads)}
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      <div id={content} className="threads-elsewhere-list" hidden={!open}>
        {open &&
          threads.map((thread) => (
            <Thread key={thread.id} thread={thread} viewer={viewer} url={url} />
          ))}
      </div>
    </section>
  );
}
