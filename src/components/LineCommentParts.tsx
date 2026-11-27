import type { ReactNode } from "react";
import { TriangleAlert, X } from "lucide-react";
import { Avatar } from "./PullRequestParts";
import type { DraftSave } from "./useLineComments";

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
          tabIndex={0}
          aria-label="Dismiss"
          onClick={onDismiss}
        >
          <X size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

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
