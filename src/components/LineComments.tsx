import { use } from "react";
import { linesLabel } from "../domain/lineComments";
import type { Lines } from "../domain/lineComments";
import type { ReviewThread } from "../domain/pullRequest";
import type { LineNote } from "../domain/reviewThreads";
import type { Attempt } from "../pullRequestWrites";
import { CommentBox } from "./CommentBox";
import {
  Header,
  mayHavePostedText,
  Problem,
  saveText,
} from "./LineCommentParts";
import { MayHavePosted } from "./MayHavePosted";
import { Body } from "./PullRequestBody";
import { ThreadChips } from "./ReviewThreads";
import type { Unfolded } from "./ReviewThreads";
import { LineCommentsContext } from "./useLineComments";
import type { LineComments, ShownDraft } from "./useLineComments";

/** A pending comment: on this computer until the review is sent. */
function PendingComment({
  draft,
  viewer,
  url,
  comments,
  onEdit,
  where,
}: {
  draft: ShownDraft & { anchor: Lines };
  viewer: string;
  url: string;
  comments: LineComments;
  /** Null where it can't be edited, as against an earlier commit. */
  onEdit: (() => void) | null;
  where: string | null;
}) {
  const problem = saveText(draft.save);
  return (
    <section className="line-comment" aria-label="Pending comment">
      <Header
        viewer={viewer}
        aside={
          <span className="line-comment-buttons">
            {onEdit && (
              <button type="button" className="pull-link" onClick={onEdit}>
                Edit
              </button>
            )}
            <button
              type="button"
              className="pull-link"
              onClick={() => comments.remove(draft)}
            >
              Delete
            </button>
          </span>
        }
      >
        <strong>You</strong> on {linesLabel(draft.anchor)}
        <span className="line-comment-pending">Pending</span>
        {where && <span className="line-comment-where">{where}</span>}
      </Header>
      <div className="line-comment-body">
        <Body text={draft.text} />
      </div>
      {draft.mayHavePosted && (
        <Problem>
          {mayHavePostedText} <a href={url}>Open on GitHub</a>
        </Problem>
      )}
      {problem && <Problem>{problem}</Problem>}
    </section>
  );
}

const sentWords = {
  sending: "Sending…",
  done: "Posted",
  refused: "Not posted",
  notSent: "Not sent",
  notLanded: "Not posted",
  unknown: "May have posted",
} as const;

/** A single comment sent from here, until a read shows it. */
function SentComment({
  attempt,
  viewer,
  url,
  comments,
}: {
  attempt: Attempt;
  viewer: string;
  url: string;
  comments: LineComments;
}) {
  const { write, state } = attempt;
  if (write.kind !== "singleComment") return null;
  return (
    <section
      className="line-comment"
      aria-label="Single comment"
      aria-busy={state.kind === "sending"}
    >
      <Header viewer={viewer}>
        <strong>You</strong> on {linesLabel(write.lines)}
        <span className="line-comment-state" role="status">
          {sentWords[state.kind]}
        </span>
      </Header>
      <div className="line-comment-body">
        <Body text={write.body} />
      </div>
      {state.kind === "unknown" ? (
        <MayHavePosted attempt={attempt} url={url} choices={comments} />
      ) : (
        (state.kind === "refused" || state.kind === "notSent") && (
          <>
            <Problem onDismiss={() => comments.dismiss(attempt.id)}>
              {state.message}
            </Problem>
            <div className="line-comment-actions">
              <button
                type="button"
                className="button secondary"
                onClick={() => {
                  comments.dismiss(attempt.id);
                  comments.open({ kind: "line", ...write.lines });
                }}
              >
                Edit
              </button>
            </div>
          </>
        )
      )}
    </section>
  );
}

/** Everything on one line: threads, pending comments, sent ones, the box. */
export function LineNoteView({
  note,
  threads,
  viewer,
  url,
  unfolded,
}: {
  note: LineNote;
  threads: readonly ReviewThread[];
  viewer: string;
  url: string;
  unfolded: Unfolded;
}) {
  const comments = use(LineCommentsContext);
  return (
    <div className="thread-chips">
      {note.threads.length > 0 && (
        <ThreadChips
          ids={note.threads}
          threads={threads}
          viewer={viewer}
          url={url}
          unfolded={unfolded}
        />
      )}
      {comments && (
        <>
          {note.drafts.map((key) => {
            const draft = comments.drafts.find((each) => each.key === key);
            return (
              draft && (
                <PendingComment
                  key={key}
                  draft={draft}
                  viewer={viewer}
                  url={url}
                  comments={comments}
                  onEdit={() => comments.open(draft.anchor)}
                  where={null}
                />
              )
            );
          })}
          {note.sent.map((id) => {
            const attempt = comments.sent.find((each) => each.id === id);
            return (
              attempt && (
                <SentComment
                  key={id}
                  attempt={attempt}
                  viewer={viewer}
                  url={url}
                  comments={comments}
                />
              )
            );
          })}
          {note.box && comments.box && (
            <CommentBox
              view={comments.box.view}
              lines={comments.box.anchor}
              isEdit={comments.box.isEdit}
              stays={comments.box.stays}
              viewer={viewer}
              url={url}
              comments={comments}
            />
          )}
        </>
      )}
    </div>
  );
}

/** Pending and sent comments of a file that have no line in what is shown. */
export function CommentsElsewhere({
  drafts,
  sent,
  viewer,
  url,
}: {
  drafts: readonly string[];
  sent: readonly string[];
  viewer: string;
  url: string;
}) {
  const comments = use(LineCommentsContext);
  if (!comments) return null;
  return (
    <>
      {drafts.map((key) => {
        const draft = comments.drafts.find((each) => each.key === key);
        return (
          draft && (
            <PendingComment
              key={key}
              draft={draft}
              viewer={viewer}
              url={url}
              comments={comments}
              onEdit={null}
              where={
                draft.head === comments.head
                  ? "Its lines aren't in this diff"
                  : "Written against an earlier commit"
              }
            />
          )
        );
      })}
      {sent.map((id) => {
        const attempt = comments.sent.find((each) => each.id === id);
        return (
          attempt && (
            <SentComment
              key={id}
              attempt={attempt}
              viewer={viewer}
              url={url}
              comments={comments}
            />
          )
        );
      })}
    </>
  );
}
