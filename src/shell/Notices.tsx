import { EyeOff, GitPullRequest, Info, TriangleAlert } from "lucide-react";
import { MergeControls } from "../components/MergeControls";
import { Notification } from "../components/Notification";
import { RebasePanel } from "../components/RebasePanel";
import { ReplayPanel } from "../components/ReplayPanel";
import { WriteNoticeRow } from "../components/UndoControls";
import { WorktreeNoticeRow } from "../components/WorktreeNotice";
import type {
  Problem,
  RepositoryRoot,
  RepositorySnapshot,
} from "../domain/repository";
import { openedText } from "../domain/openPull";
import type { VisibilityRule } from "../domain/visibility";
import { repositoryWarnings } from "../overview";
import type { WritesView } from "../useWrites";
import { ResolutionDraftList } from "./MergeRegions";
import { isBranch } from "./navigation";
import type { SyncControls } from "./sync";
import type { MergePanel } from "./useMergePanel";
import type { ResolutionDrafts } from "./useResolutionDrafts";
import type { Navigation } from "./useNavigation";
import type { OpenPull } from "./useOpenPull";
import type { RefWrites } from "./useRefWrites";

/** The panels pinned above the panes, then the notifications floating over them, each in this order. */
export function Notices({
  snapshot,
  writes,
  merge,
  drafts,
  sync,
  persistenceError,
  error,
  onRetry,
  rule,
  nav,
  worktree,
  openPull,
}: {
  snapshot: RepositorySnapshot | null;
  writes: WritesView;
  merge: Pick<MergePanel, "controls" | "replay" | "rebase">;
  drafts: ResolutionDrafts;
  sync: Pick<SyncControls, "opened">;
  persistenceError: string | null;
  error: Problem | null | undefined;
  onRetry: () => void;
  rule: VisibilityRule;
  nav: Pick<Navigation, "jump" | "showInGraph">;
  worktree: {
    refWrites: Pick<RefWrites, "worktreeNotice" | "dismissWorktreeNotice">;
    open: (root: RepositoryRoot) => void;
  };
  openPull: Pick<OpenPull, "notice" | "dismissNotice" | "view">;
}) {
  const opened = openPull.notice;
  const { worktreeNotice, dismissWorktreeNotice } = worktree.refWrites;
  const { repository } = sync.opened;
  const { jumped, jumpedUnloaded, hiddenJump } = nav.jump;
  return (
    <>
      {merge.controls && (
        <MergeControls key={merge.controls.root} {...merge.controls} />
      )}
      {merge.replay && (
        <ReplayPanel key={`replay:${merge.replay.root}`} {...merge.replay} />
      )}
      {merge.rebase && (
        <RebasePanel key={`rebase:${merge.rebase.root}`} {...merge.rebase} />
      )}
      <ResolutionDraftList drafts={drafts} />
      <div className="notifications">
        <WriteNoticeRow writes={writes} />
        {worktreeNotice && (
          <WorktreeNoticeRow
            notice={worktreeNotice}
            onOpen={(root) => {
              dismissWorktreeNotice();
              worktree.open(root);
            }}
            onDismiss={dismissWorktreeNotice}
          />
        )}
        {opened && (
          <Notification
            tone="info"
            icon={<GitPullRequest size={16} />}
            actionsBelow
            actions={[
              {
                label: "Open pull request",
                primary: true,
                run: () => {
                  openPull.dismissNotice();
                  openPull.view(opened.github, opened.number);
                },
              },
              { label: "Stay here", run: openPull.dismissNotice },
            ]}
          >
            {openedText(opened.number, opened.head, opened.base)}
          </Notification>
        )}
        {persistenceError && (
          <Notification tone="error" icon={<TriangleAlert size={16} />}>
            {persistenceError}
          </Notification>
        )}
        {error && (
          <Notification
            tone="error"
            icon={<TriangleAlert size={16} />}
            actions={[{ label: "Try again", run: onRetry }]}
          >
            {error.message} The last successful view is retained.
          </Notification>
        )}
        {repository &&
          repositoryWarnings(repository).map((warning) => (
            <Notification
              key={warning}
              tone="error"
              icon={<TriangleAlert size={16} />}
            >
              {warning}
            </Notification>
          ))}
        {hiddenJump && snapshot && (
          <Notification
            tone="info"
            icon={<EyeOff size={16} />}
            actions={[
              {
                label: isBranch(hiddenJump)
                  ? `Show ${hiddenJump.name}`
                  : "Show all branches",
                run: () => nav.showInGraph(snapshot.root, hiddenJump),
              },
            ]}
          >
            {hiddenJump.name}{" "}
            {rule.kind === "solo"
              ? "is outside the soloed branches."
              : "is hidden in the graph."}
          </Notification>
        )}
        {jumped && jumpedUnloaded && snapshot && (
          <Notification tone="info" icon={<Info size={16} />}>
            {jumped.name} is older than the newest{" "}
            {snapshot.commits.length.toLocaleString()} loaded commits.
          </Notification>
        )}
      </div>
    </>
  );
}
