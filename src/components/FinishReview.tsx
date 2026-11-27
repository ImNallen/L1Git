import { useId, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { ChevronRight, Eye, MessageSquare } from "lucide-react";
import { remindersOf } from "../domain/finishReview";
import type { ReviewEvent } from "../domain/finishReview";
import type { Lines } from "../domain/lineComments";
import type { ReviewThread } from "../domain/pullRequest";
import { counted, personName } from "../domain/pullRequestDetail";
import type { RangeFile } from "../domain/range";
import { firstWords } from "../domain/reviewThreads";
import { mac } from "../repositories";
import { useModalDialog } from "./Dialog";
import { Problem, saveText } from "./LineCommentParts";
import { MayHavePosted } from "./MayHavePosted";
import type { FinishReview } from "./useFinishReview";
import type { LineComments } from "./useLineComments";

const eventWords: Record<ReviewEvent, { title: string; text: string }> = {
  comment: { title: "Comment", text: "Give feedback without approving." },
  approve: { title: "Approve", text: "Ready to merge from your side." },
  requestChanges: {
    title: "Request changes",
    text: "These must be addressed before merging.",
  },
};
const MOST_THREADS = 3;
/** Room it leaves under itself, and the least height it takes. */
const EDGE = 8;
const LEAST_HEIGHT = 200;

const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const placeOf = ({ path, line, start }: Lines) =>
  `${fileName(path)}:${start === null ? line : `${start.line}–${line}`}`;

function Comments<Comment extends { key: string }>({
  title,
  comments,
  children,
}: {
  title: string;
  comments: readonly Comment[];
  children: (comment: Comment) => ReactNode;
}) {
  return (
    <section className="finish-section" aria-label={title}>
      <h3>{title}</h3>
      <ul className="finish-comments">
        {comments.map((comment) => (
          <li key={comment.key}>{children(comment)}</li>
        ))}
      </ul>
    </section>
  );
}

type PopoverProps = Omit<Parameters<typeof FinishReviewPopover>[0], "under">;

/** The toolbar's Finish review, which counts the pending comments that
 * send, and its popover. */
export function FinishReviewButton(props: PopoverProps) {
  const { finish } = props;
  const button = useRef<HTMLButtonElement>(null);
  const count = finish.current.length;
  const { refocus, refocused } = finish;
  useLayoutEffect(() => {
    if (!refocus) return;
    button.current?.focus();
    refocused();
  }, [refocus, refocused]);
  return (
    <>
      <span className="finish-sent" role="status">
        {finish.unknown
          ? "Your review may have posted."
          : finish.done
            ? "Review sent."
            : ""}
      </span>
      <button
        ref={button}
        type="button"
        className="button primary finish-button"
        aria-label={
          count > 0
            ? `Finish review, ${counted(count, "pending comment")}`
            : "Finish review"
        }
        aria-haspopup="dialog"
        aria-expanded={finish.isOpen}
        onClick={finish.open}
      >
        Finish review
        {count > 0 && <span aria-hidden="true"> · {count}</span>}
      </button>
      {finish.isOpen && <FinishReviewPopover {...props} under={button} />}
    </>
  );
}

/** The popover under Finish review. */
function FinishReviewPopover({
  finish,
  comments,
  under,
  number,
  author,
  viewer,
  url,
  files,
  viewed,
  threads,
  onGoTo,
  onShowUnviewed,
  onOpenThread,
}: {
  finish: FinishReview;
  comments: LineComments;
  /** The button it opens under. */
  under: RefObject<HTMLElement | null>;
  number: number;
  author: string | null;
  viewer: string;
  url: string;
  files: readonly RangeFile[];
  viewed: ReadonlySet<RangeFile>;
  threads: readonly ReviewThread[];
  onGoTo: (lines: Lines, isOlder: boolean) => void;
  onShowUnviewed: () => void;
  onOpenThread: (thread: ReviewThread) => void;
}) {
  const summary = useRef<HTMLTextAreaElement>(null);
  const back = () => {
    if (finish.send.kind === "sending") return;
    finish.close();
    under.current?.focus();
  };
  const { ref, onCancel } = useModalDialog(back, () =>
    summary.current?.focus(),
  );
  const id = useId();
  const [place, setPlace] = useState<{
    top: number;
    right: number;
    maxHeight: number;
  } | null>(null);
  useLayoutEffect(() => {
    const fit = () => {
      const bounds = under.current?.getBoundingClientRect();
      if (!bounds) return;
      const top = bounds.bottom + 6;
      setPlace({
        top,
        right: Math.max(document.documentElement.clientWidth - bounds.right, 8),
        maxHeight: Math.max(window.innerHeight - top - EDGE, LEAST_HEIGHT),
      });
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [under]);
  const { send, pending, current, older, events, event, reason } = finish;
  const isSending = send.kind === "sending";
  /** The host holds the words while a send is out or may have posted. */
  const isHeld = send.kind !== "idle";
  const reminders = remindersOf({ files, viewed, threads });
  const shownThreads = reminders.unresolved.slice(0, MOST_THREADS);
  const go = (act: () => void) => () => {
    finish.close();
    act();
  };
  const summaryWords = saveText(finish.summarySave);
  return (
    <dialog
      ref={ref}
      className="finish-review"
      aria-labelledby={`${id}-title`}
      aria-busy={isSending}
      style={place ?? undefined}
      onCancel={(event) => {
        // Closed while its review is on its way, it would hide how it ended.
        if (isSending) event.preventDefault();
        else onCancel(event);
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) back();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          void finish.submit();
        }
      }}
    >
      <header className="finish-header">
        <h2 id={`${id}-title`}>Finish your review</h2>
        <span>#{number}</span>
      </header>
      {pending ? (
        <section className="finish-section finish-elsewhere">
          <p>
            You have a review in progress on GitHub with{" "}
            {counted(pending.comments.total, "comment")}. GitHub takes one
            review at a time, so L1 Git can&apos;t add to it.
          </p>
          {current.length > 0 && (
            <p>
              Your {counted(current.length, "pending comment")} here{" "}
              {current.length === 1 ? "stays" : "stay"} on this computer.
            </p>
          )}
        </section>
      ) : finish.listed.length > 0 ? (
        <Comments
          title={counted(finish.listed.length, "pending comment")}
          comments={finish.listed}
        >
          {(draft) => (
            <button
              type="button"
              className="finish-comment"
              onClick={go(() => onGoTo(draft.lines, false))}
            >
              <MessageSquare size={13} aria-hidden="true" />
              <code>{placeOf(draft.lines)}</code>
              <span>{firstWords(draft.text)}</span>
              {draft.mayHavePosted && (
                <span className="line-comment-pending">May have posted</span>
              )}
              <ChevronRight size={14} aria-hidden="true" />
            </button>
          )}
        </Comments>
      ) : (
        <p className="finish-section finish-none">
          No pending comments. Choose lines in the diff to add some, or send a
          summary.
        </p>
      )}
      {older.length > 0 && (
        <Comments title="Written against an earlier commit" comments={older}>
          {(draft) => (
            <div className="finish-comment finish-older">
              <code>{placeOf(draft.anchor)}</code>
              <span>{firstWords(draft.text)}</span>
              <button
                type="button"
                className="pull-link"
                onClick={go(() => onGoTo(draft.anchor, true))}
              >
                Open at that line
              </button>
              <button
                type="button"
                className="pull-link"
                onClick={() => comments.remove(draft)}
              >
                Delete
              </button>
            </div>
          )}
        </Comments>
      )}
      {older.length > 0 && (
        <p className="finish-note">
          These aren&apos;t sent. Their lines are of an earlier commit, so read
          the new code and comment again where it still applies.
        </p>
      )}
      {(reminders.notViewed > 0 || shownThreads.length > 0) && (
        <section className="finish-section" aria-label="Before you send">
          {reminders.notViewed > 0 && (
            <p className="finish-reminder">
              <Eye size={14} aria-hidden="true" />
              <span>
                {reminders.notViewed.toLocaleString()} of{" "}
                {counted(reminders.of, "file")} not viewed yet
              </span>
              <button
                type="button"
                className="pull-link"
                onClick={go(onShowUnviewed)}
              >
                Show them
              </button>
            </p>
          )}
          {shownThreads.map((thread) => (
            <p key={thread.id} className="finish-reminder">
              <MessageSquare size={14} aria-hidden="true" />
              <span>
                {personName(thread.comments.items[0]?.by ?? null, viewer)}
                &apos;s thread on {fileName(thread.path)} is unresolved
              </span>
              <button
                type="button"
                className="pull-link"
                onClick={go(() => onOpenThread(thread))}
              >
                Open
              </button>
            </p>
          ))}
          {reminders.unresolved.length > shownThreads.length && (
            <p className="finish-note">
              And{" "}
              {counted(
                reminders.unresolved.length - shownThreads.length,
                "more unresolved thread",
              )}
              .
            </p>
          )}
        </section>
      )}
      <section className="finish-section">
        <textarea
          ref={summary}
          className="finish-summary"
          aria-label="Summary"
          placeholder={`Summary${author && author !== viewer ? ` for ${author}` : ""} (optional). Markdown works here.`}
          value={finish.summary}
          readOnly={isHeld}
          onChange={(change) => finish.typeSummary(change.target.value)}
        />
        {summaryWords && <Problem>{summaryWords}</Problem>}
      </section>
      <fieldset className="finish-section finish-events" disabled={isHeld}>
        <legend className="visually-hidden">Your review</legend>
        {events.map((each) => (
          <label key={each} className="finish-event">
            <input
              type="radio"
              name={`${id}-event`}
              aria-label={eventWords[each].title}
              aria-describedby={`${id}-${each}`}
              checked={event === each}
              onChange={() => finish.choose(each)}
            />
            <span>
              <strong>{eventWords[each].title}</strong>
              <span id={`${id}-${each}`}>{eventWords[each].text}</span>
            </span>
          </label>
        ))}
        {events.length === 1 && (
          <p className="finish-note">
            This is your pull request, so GitHub takes a comment only.
          </p>
        )}
      </fieldset>
      {send.kind === "idle" && send.problem && (
        <Problem onDismiss={finish.clearProblem}>{send.problem}</Problem>
      )}
      {send.kind === "unknown" && (
        <MayHavePosted
          key={send.attempt.id}
          attempt={send.attempt}
          url={url}
          choices={finish}
          home={() => summary.current}
        />
      )}
      <footer className="finish-footer">
        <span className="line-comment-saved" role="status">
          {isSending
            ? "Sending your review…"
            : (reason ?? `${mac ? "⌘" : "Ctrl+"}Enter to submit`)}
        </span>
        <button
          type="button"
          className="button secondary"
          aria-disabled={isSending}
          onClick={back}
        >
          Cancel
        </button>
        {pending && (
          <a
            className="button secondary"
            href={url}
            target="_blank"
            rel="noreferrer"
          >
            Open it on GitHub
          </a>
        )}
        <button
          type="button"
          className="button primary"
          aria-disabled={isHeld || reason !== null}
          onClick={() => void finish.submit()}
        >
          {pending ? "Submit it as it is" : "Submit review"}
        </button>
      </footer>
    </dialog>
  );
}
