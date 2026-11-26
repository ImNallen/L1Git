import type { ReactNode } from "react";
import { ExternalLink, TriangleAlert, X } from "lucide-react";
import type { Attempt } from "../pullRequestWrites";
import { Avatar } from "./PullRequestParts";
import type { DraftSave, LineComments } from "./useLineComments";

export const mayHavePostedText =
  "L1 Git sent this once and got no answer, so it may have posted. Look on GitHub before you send it again.";

export function Problem({
  children,
  onDismiss,
}: {
  children: ReactNode;
  onDismiss?: () => void;
}) {
  return (
    <div className="line-comment-problem" role="alert">
      <TriangleAlert size={14} aria-hidden="true" />
      <span>{children}</span>
      {onDismiss && (
        <button
          type="button"
          className="notice-dismiss"
          aria-label="Dismiss"
          onClick={onDismiss}
        >
          <X size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

const OnGitHub = ({ url }: { url: string }) => (
  <a className="button secondary" href={url} target="_blank" rel="noreferrer">
    <ExternalLink size={13} aria-hidden="true" />
    Open on GitHub
  </a>
);

/** What the footer says of the words. Typing saves a moment later, and a
 * crash loses at most that moment. */
export function saveText(save: DraftSave | null): string | null {
  switch (save?.kind) {
    case undefined:
    case "saved":
    case "saving":
      return null;
    case "unsaved":
      return `Not saved. ${save.why}`;
    case "tooLong":
      return `GitHub takes at most ${save.most.toLocaleString()} characters, so this isn't saved.`;
    case "changedElsewhere":
      return save.theirs
        ? "Another L1 Git window changed this comment."
        : "Another L1 Git window deleted this comment.";
  }
}

export function Unknown({
  attempt,
  url,
  comments,
}: {
  attempt: Attempt;
  url: string;
  comments: LineComments;
}) {
  if (attempt.state.kind !== "unknown") return null;
  const { message, kept } = attempt.state;
  return (
    <>
      <Problem>{message}</Problem>
      <div className="line-comment-actions">
        <OnGitHub url={url} />
        {kept ? (
          <>
            <button
              type="button"
              className="button secondary"
              onClick={() => void comments.keepAsDraft(attempt.id)}
            >
              Keep as draft
            </button>
            <button
              type="button"
              className="button secondary"
              onClick={() => comments.sendAnyway(attempt.id)}
            >
              Send anyway
            </button>
          </>
        ) : (
          <button
            type="button"
            className="button secondary"
            onClick={() => comments.dismiss(attempt.id)}
          >
            Dismiss
          </button>
        )}
      </div>
    </>
  );
}

export function Header({
  viewer,
  children,
  aside,
}: {
  viewer: string;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <header className="line-comment-header">
      <Avatar login={viewer} />
      <span className="line-comment-title">{children}</span>
      {aside}
    </header>
  );
}
