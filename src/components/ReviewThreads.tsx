import { memo, useId } from "react";
import { ChevronDown, MessageSquare } from "lucide-react";
import type { ReviewThread } from "../domain/pullRequest";
import { lineLabel } from "../domain/pullRequestDetail";
import { chipOf, elsewhereLabel } from "../domain/reviewThreads";
import type { Elsewhere } from "../domain/reviewThreads";
import { CommentsElsewhere } from "./LineComments";
import { Avatar } from "./PullRequestParts";
import { useThreadWaits } from "./conversationWriting";
import { Thread, ThreadComments } from "./PullRequestThread";
import { ThreadActions } from "./ThreadActions";

/** Which threads are unfolded, and which files' other ones. */
export type Unfolded = {
  ids: ReadonlySet<string>;
  toggle: (id: string) => void;
};

/** A thread in one row, which unfolds. */
const ThreadChip = memo(function ThreadChip({
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
  // A reply or a resolve that waits here stays in sight.
  const shown = useThreadWaits(thread.id) || open;
  return (
    <section className="thread-chip" aria-label="Thread">
      <button
        type="button"
        className="thread-chip-row"
        aria-expanded={shown}
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
      <div id={content} hidden={!shown}>
        {shown && (
          <>
            <ThreadComments thread={thread} viewer={viewer} url={url} />
            <ThreadActions thread={thread} short />
          </>
        )}
      </div>
    </section>
  );
});

/** The threads on one line, in the list of what is on it. */
export function ThreadChips({
  ids,
  threads,
  viewer,
  url,
  unfolded,
}: {
  ids: readonly string[];
  threads: readonly ReviewThread[];
  viewer: string;
  url: string;
  unfolded: Unfolded;
}) {
  return (
    <>
      {threads
        .filter(({ id }) => ids.includes(id))
        .map((thread) => (
          <ThreadChip
            key={thread.id}
            thread={thread}
            viewer={viewer}
            url={url}
            open={unfolded.ids.has(thread.id)}
            onToggle={unfolded.toggle}
          />
        ))}
    </>
  );
}

/** The threads and comments of a file that have no line in what is shown
 * of it. */
export function ThreadsElsewhere({
  path,
  elsewhere,
  viewer,
  url,
  unfolded,
}: {
  path: string;
  elsewhere: Elsewhere;
  viewer: string;
  url: string;
  unfolded: Unfolded;
}) {
  const id = `elsewhere ${path}`;
  const open = unfolded.ids.has(id);
  const content = useId();
  return (
    <section className="threads-elsewhere" aria-label="Other comments">
      <button
        type="button"
        className="threads-elsewhere-row"
        aria-expanded={open}
        aria-controls={content}
        onClick={() => unfolded.toggle(id)}
      >
        <MessageSquare size={14} aria-hidden="true" />
        {elsewhereLabel(elsewhere)}
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      <div id={content} className="threads-elsewhere-list" hidden={!open}>
        {open && (
          <>
            <CommentsElsewhere
              drafts={elsewhere.drafts}
              sent={elsewhere.sent}
              viewer={viewer}
              url={url}
            />
            {elsewhere.threads.map((thread) => (
              <Thread
                key={thread.id}
                thread={thread}
                viewer={viewer}
                url={url}
              />
            ))}
          </>
        )}
      </div>
    </section>
  );
}
