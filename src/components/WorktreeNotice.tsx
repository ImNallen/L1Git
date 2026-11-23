import { Fragment } from "react";
import { FolderGit2, TriangleAlert, X } from "lucide-react";
import { hookOutputTail } from "../domain/operations";
import type { RepositoryRoot } from "../domain/repository";
import type { WorktreeNotice } from "../shell/useRefWrites";

/** Asks whether to open a worktree Try it locally made, and never moves on its own. */
export function WorktreeNoticeRow({
  notice,
  onOpen,
  onDismiss,
}: {
  notice: WorktreeNotice;
  onOpen: (root: RepositoryRoot) => void;
  onDismiss: () => void;
}) {
  const dismiss = (
    <button className="notice-dismiss" aria-label="Dismiss" onClick={onDismiss}>
      <X size={13} />
    </button>
  );
  if (notice.kind === "removed")
    return (
      <div className="notice info-notice" role="status">
        <FolderGit2 size={14} />
        <span>Removed worktree {notice.name}. Removal cannot be undone.</span>
        {dismiss}
      </div>
    );
  if (notice.kind === "removeFailed")
    return (
      <div className="notice error-notice" role="alert">
        <TriangleAlert size={14} />
        <span>Could not remove the worktree. {notice.problem.message}</span>
        {dismiss}
      </div>
    );
  const { created, branch } = notice;
  return (
    <div className="notice info-notice" role="status">
      <FolderGit2 size={14} />
      <span>
        Created {created.name} from {branch}. It is in the sidebar.
        {created.trouble && ` ${created.trouble.message}`}
        {created.trouble &&
          hookOutputTail(created.trouble).map((line, index) => (
            <Fragment key={index}>
              <br />
              <code>{line}</code>
            </Fragment>
          ))}
      </span>
      <button onClick={() => onOpen(created.root)}>Open worktree</button>
      <button onClick={onDismiss}>Stay here</button>
    </div>
  );
}
