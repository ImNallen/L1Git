import { FolderGit2, TriangleAlert } from "lucide-react";
import { hookOutputTail } from "../domain/operations";
import type { RepositoryRoot } from "../domain/repository";
import type { WorktreeNotice } from "../shell/useRefWrites";
import { Notification } from "./Notification";

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
  if (notice.kind === "removeFailed")
    return (
      <Notification
        tone="error"
        icon={<TriangleAlert size={16} />}
        onDismiss={onDismiss}
      >
        Could not remove the worktree. {notice.problem.message}
      </Notification>
    );
  const { created, branch } = notice;
  return (
    <Notification
      tone="info"
      icon={<FolderGit2 size={16} />}
      output={created.trouble ? hookOutputTail(created.trouble) : []}
      actionsBelow
      actions={[
        {
          label: "Open worktree",
          primary: true,
          run: () => onOpen(created.root),
        },
        { label: "Stay here", run: onDismiss },
      ]}
    >
      Created {created.name} from {branch}. It is in the sidebar.
      {created.trouble && ` ${created.trouble.message}`}
    </Notification>
  );
}
