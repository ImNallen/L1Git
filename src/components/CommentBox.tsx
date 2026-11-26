import { useId, useState } from "react";
import { draftText } from "../domain/drafts";
import { linesLabel } from "../domain/lineComments";
import type { Lines } from "../domain/lineComments";
import { Body } from "./PullRequestBody";
import {
  Header,
  mayHavePostedText,
  Problem,
  saveText,
  Unknown,
} from "./LineCommentParts";
import type { BoxView, LineComments } from "./useLineComments";

/** The box under the chosen lines. Its words are a draft on this computer. */
export function CommentBox({
  view,
  lines,
  isEdit,
  viewer,
  url,
  comments,
}: {
  view: BoxView;
  lines: Lines;
  isEdit: boolean;
  viewer: string;
  url: string;
  comments: LineComments;
}) {
  const [tab, setTab] = useState<"write" | "preview">("write");
  const id = useId();
  const label = `Comment on ${linesLabel(lines)}`;
  const writing = view.kind === "writing" ? view : null;
  const hasWords = draftText(view.text) === "takes";
  const isOff = writing === null || !hasWords;
  const tabs = (
    <div className="line-comment-tabs" role="tablist" aria-label={label}>
      {(["write", "preview"] as const).map((each) => (
        <button
          key={each}
          type="button"
          role="tab"
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
      aria-busy={view.kind === "sending"}
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
            className="line-comment-text"
            aria-label={label}
            placeholder="Leave a comment. Markdown works here."
            value={view.text}
            readOnly={writing === null}
            autoFocus
            onChange={(event) => comments.type(event.target.value)}
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
            onClick={() => comments.settleBox("mine")}
          >
            Keep mine
          </button>{" "}
          <button
            type="button"
            className="pull-link"
            onClick={() => comments.settleBox("theirs")}
          >
            Use theirs
          </button>
        </Problem>
      )}
      {writing?.problem && (
        <Problem onDismiss={comments.clearProblem}>{writing.problem}</Problem>
      )}
      {view.kind === "unknown" && (
        <Unknown attempt={view.attempt} url={url} comments={comments} />
      )}
      <footer className="line-comment-footer">
        <span
          className="line-comment-saved"
          role={view.kind === "sending" ? "status" : undefined}
        >
          {view.kind === "sending"
            ? "Sending…"
            : view.kind === "unknown"
              ? "May have posted"
              : (saveText(view.save) ?? "Saved as a draft on this machine")}
        </span>
        <button
          type="button"
          className="button secondary"
          aria-disabled={view.kind === "sending"}
          onClick={() => {
            if (view.kind !== "sending") comments.cancel();
          }}
        >
          Cancel
        </button>
        {isEdit ? (
          <button
            type="button"
            className="button primary"
            aria-disabled={isOff}
            onClick={() => {
              if (!isOff) comments.keep();
            }}
          >
            Update comment
          </button>
        ) : (
          <>
            <button
              type="button"
              className="button secondary"
              aria-disabled={isOff}
              onClick={() => {
                if (!isOff) void comments.single();
              }}
            >
              Add single comment
            </button>
            <button
              type="button"
              className="button primary"
              aria-disabled={isOff || comments.isBehind}
              aria-describedby={comments.isBehind ? `${id}-behind` : undefined}
              onClick={() => {
                if (!isOff && !comments.isBehind) comments.keep();
              }}
            >
              {comments.hasReview ? "Add review comment" : "Start a review"}
            </button>
          </>
        )}
      </footer>
      {comments.isBehind && (
        <p id={`${id}-behind`} className="line-comment-note">
          New commits were pushed. A review goes with the newest commit, so show
          them to add this to your review.
        </p>
      )}
    </section>
  );
}
