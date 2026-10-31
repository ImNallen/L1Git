import { EyeOff, Info, TriangleAlert } from "lucide-react";
import { MergeControls } from "../components/MergeControls";
import { WriteNoticeRow } from "../components/UndoControls";
import type { Problem, RepositorySnapshot } from "../domain/repository";
import type { VisibilityRule } from "../domain/visibility";
import { repositoryWarnings } from "../overview";
import type { WritesView } from "../useWrites";
import { ResolutionDraftList } from "./MergeRegions";
import { isBranch } from "./navigation";
import type { SyncControls } from "./sync";
import { PushNotice } from "./SyncRegions";
import type { MergePanel, ResolutionDrafts } from "./useMergePanel";
import type { Navigation } from "./useNavigation";

/** The rows above the panes, in this order. */
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
}: {
  snapshot: RepositorySnapshot | null;
  writes: WritesView;
  merge: Pick<MergePanel, "controls">;
  drafts: ResolutionDrafts;
  sync: Pick<SyncControls, "push" | "opened">;
  persistenceError: string | null;
  error: Problem | null | undefined;
  onRetry: () => void;
  rule: VisibilityRule;
  nav: Pick<Navigation, "jump" | "showInGraph">;
}) {
  const { repository } = sync.opened;
  const { jumped, jumpedUnloaded, hiddenJump } = nav.jump;
  return (
    <>
      <WriteNoticeRow writes={writes} />
      {merge.controls && (
        <MergeControls key={merge.controls.root} {...merge.controls} />
      )}
      <ResolutionDraftList drafts={drafts} />
      <PushNotice push={sync.push} />
      {persistenceError && (
        <div className="notice error-notice" role="alert">
          <TriangleAlert size={14} />
          <span>{persistenceError}</span>
        </div>
      )}
      {error && (
        <div className="notice error-notice" role="alert">
          <TriangleAlert size={14} />
          <span>{error.message} The last successful view is retained.</span>
          <button onClick={onRetry}>Try again</button>
        </div>
      )}
      {repository &&
        repositoryWarnings(repository).map((warning) => (
          <div className="notice error-notice" role="alert" key={warning}>
            <TriangleAlert size={14} />
            <span>{warning}</span>
          </div>
        ))}
      {hiddenJump && snapshot && (
        <div className="notice info-notice" role="status">
          <EyeOff size={14} />
          <span>
            {hiddenJump.name}{" "}
            {rule.kind === "solo"
              ? "is outside the soloed branches."
              : "is hidden in the graph."}
          </span>
          <button onClick={() => nav.showInGraph(snapshot.root, hiddenJump)}>
            {isBranch(hiddenJump)
              ? `Show ${hiddenJump.name}`
              : "Show all branches"}
          </button>
        </div>
      )}
      {jumped && jumpedUnloaded && snapshot && (
        <div className="notice info-notice" role="status">
          <Info size={14} />
          <span>
            {jumped.name} is older than the newest{" "}
            {snapshot.commits.length.toLocaleString()} loaded commits.
          </span>
        </div>
      )}
    </>
  );
}
