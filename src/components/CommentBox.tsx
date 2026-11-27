import { useEffect, useId, useRef, useState } from "react";
import { draftText } from "../domain/drafts";
import { mac } from "../repositories";
import { messageKeys } from "./CommitBox";
import { linesLabel } from "../domain/lineComments";
import type { Lines } from "../domain/lineComments";
import { Body } from "./PullRequestBody";
import {
  Header,
  mayHavePostedText,
  Problem,
  saveText,
} from "./LineCommentParts";
import { MayHavePosted } from "./MayHavePosted";
import type { BoxView, LineComments } from "./useLineComments";

/** The box under the chosen lines. Its words are a draft on this computer. */
export function CommentBox({
  view,
  lines,
  isEdit,
  stays,
  viewer,
  url,
  comments,
}: {
  view: BoxView;
  lines: Lines;
  isEdit: boolean;
  /** Grows each time other lines were chosen while it held typed words. */
  stays: number;
  viewer: string;
  url: string;
  comments: LineComments;
}) {
  const [tab, setTab] = useState<"write" | "preview">("write");
  const words = useRef<HTMLTextAreaElement>(null);
  const place = JSON.stringify(lines);
  // A click on a line number, or on the gutter plus that goes away, moves the
  // focus after the box mounts, and Pierre keeps the box when it moves to
  // other lines, so the words take the focus a frame after each.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const box = words.current;
      if (!box) return;
      box.focus({ preventScroll: true });
      box.setSelectionRange(box.value.length, box.value.length);
      if (stays > 0) box.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [place, stays]);
  const id = useId();
  const label = `Comment on ${linesLabel(lines)}`;
  const writing = view.kind === "writing" ? view : null;
  const isSending =
    view.kind === "sending" || (view.kind === "held" && view.isSending);
  const hasWords = draftText(view.text) === "takes";
  const isOff = writing === null || !hasWords;
  const keepOff = isOff || (!isEdit && comments.isBehind);
  /** The main button, which Cmd/Ctrl+Enter presses too. */
  const keep = () => {
    if (!keepOff) comments.keep();
  };
  const shortcut = `${mac ? "⌘" : "Ctrl+"}Enter`;
  const tabs = (
    <div className="line-comment-tabs" role="tablist" aria-label={label}>
      {(["write", "preview"] as const).map((each) => (
        <button
          key={each}
          type="button"
          role="tab"
          tabIndex={0}
          id={`${id}-${each}`}
          aria-selected={tab === each}
          aria-controls={`${id}-panel`}
          onClick={() => setTab(each)}
        >
          {each === "write" ? "Write" : "Preview"}
        </button>
      ))}
    </div>
  );
  return (
    <section
      className="line-comment line-comment-box"
      aria-label={label}
      aria-busy={isSending}
    >
      <Header viewer={viewer} aside={tabs}>
        {label}
      </Header>
      <div
        id={`${id}-panel`}
        role="tabpanel"
        aria-labelledby={`${id}-${tab}`}
        className="line-comment-panel"
      >
        {tab === "write" ? (
          <textarea
            ref={words}
            className="line-comment-text"
            aria-label={label}
            placeholder="Leave a comment. Markdown works here."
            value={view.text}
            readOnly={writing === null}
            onChange={(event) => comments.type(event.target.value)}
            onKeyDown={messageKeys(keep)}
          />
        ) : (
          <div className="line-comment-preview">
            {hasWords ? <Body text={view.text} /> : <p>Nothing to preview.</p>}
          </div>
        )}
      </div>
      {writing?.mayHavePosted && (
        <Problem>
          {mayHavePostedText} <a href={url}>Open on GitHub</a>
        </Problem>
      )}
      {writing?.save?.kind === "changedElsewhere" && (
        <Problem>
          {saveText(writing.save)}{" "}
          <button
            type="button"
            className="pull-link"
            tabIndex={0}
            onClick={() => comments.settleBox("mine")}
          >
            Keep mine
          </button>{" "}
          <button
            type="button"
            className="pull-link"
            tabIndex={0}
            onClick={() => comments.settleBox("theirs")}
          >
            Use theirs
          </button>
        </Problem>
      )}
      {writing?.problem && (
        <Problem onDismiss={comments.clearProblem}>{writing.problem}</Problem>
      )}
      {view.kind === "held" && (
        <p className="line-comment-note">
          {view.isSending
            ? "These words are on their way to GitHub with another write. You can change them once it ends."
            : "Another write carried these words and may have posted. Choose Keep as draft or Send anyway on it to change them."}
        </p>
      )}
      {view.kind === "unknown" && (
        <MayHavePosted
          key={view.attempt.id}
          attempt={view.attempt}
          url={url}
          choices={comments}
          home={() => words.current}
        />
      )}
      <footer className="line-comment-footer">
        <span
          className="line-comment-saved"
          role={isSending ? "status" : undefined}
        >
          {isSending
            ? "Sending…"
            : view.kind === "unknown" || view.kind === "held"
              ? "May have posted"
              : (saveText(view.save) ?? "Saved as a draft on this machine")}
        </span>
        {/* WebKit's Tab skips a button with no tabIndex of its own. */}
        <button
          type="button"
          className="button secondary"
          tabIndex={0}
          aria-disabled={view.kind === "sending"}
          onClick={() => {
            if (view.kind !== "sending") comments.cancel();
          }}
        >
          Cancel
        </button>
        {!isEdit && (
          <button
            type="button"
            className="button secondary"
            tabIndex={0}
            aria-disabled={isOff}
            onClick={() => {
              if (!isOff) void comments.single();
            }}
          >
            Add single comment
          </button>
        )}
        <button
          type="button"
          className="button primary"
          tabIndex={0}
          aria-disabled={keepOff}
          aria-describedby={
            !isEdit && comments.isBehind ? `${id}-behind` : undefined
          }
          title={keepOff ? undefined : shortcut}
          onClick={keep}
        >
          {isEdit
            ? "Update comment"
            : comments.hasReview
              ? "Add review comment"
              : "Start a review"}
        </button>
      </footer>
      {comments.isBehind && !isEdit && (
        <p id={`${id}-behind`} className="line-comment-note">
          New commits were pushed. A review goes with the newest commit, so show
          them to add this to your review.
        </p>
      )}
    </section>
  );
}
