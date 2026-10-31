import { FolderGit2, Plus, TriangleAlert } from "lucide-react";
import { Suspense } from "react";
import type { AppearanceState } from "../appearance";
import { History, HistoryPlaceholder } from "../components/History";
import { FileDiffPane } from "./lazyViews";
import type { DiffPane } from "./useDiffPane";
import type { Focus } from "./useFocus";
import type { HistoryColumnsGroup, HistoryPane } from "./useHistoryPane";
import type { Navigation } from "./useNavigation";
import type { CommitActions } from "./useRefWrites";
import type { WriteLoop } from "./useWriteLoop";
import type { WorkspaceApi, WorkspaceView } from "./workspaceView";

export function WorkspacePanes({
  app,
  view,
  history,
  columns,
  nav,
  commitActions,
  focus,
  diff,
  loop,
  appearance,
  onAdd,
}: {
  app: WorkspaceApi;
  view: Pick<WorkspaceView, "opening" | "busy" | "fileOpen">;
  history: Pick<HistoryPane, "model" | "shows">;
  columns: HistoryColumnsGroup;
  nav: Pick<Navigation, "selecting" | "revealSeq">;
  commitActions: CommitActions;
  focus: Pick<Focus, "historyRef" | "fileDiffRef">;
  diff: DiffPane;
  loop: Pick<WriteLoop, "writes" | "rereadChanges">;
  appearance: AppearanceState;
  onAdd: () => void;
}) {
  const { fileDiff, workspace } = app;
  const { model } = history;
  return (
    <div className="workspace-panes">
      {model ? (
        <>
          <History
            ref={focus.historyRef}
            model={model}
            selecting={nav.selecting}
            revealSeq={nav.revealSeq}
            columns={columns}
            commitActions={commitActions}
            onOpenFirstFile={app.openFirstFile}
            onCancelOpen={app.cancelOpenFirstFile}
            scrollTopOf={app.scrollTopOf}
            onScroll={app.rememberScroll}
            busy={view.busy}
            hidden={view.fileOpen}
          />
          {fileDiff.kind !== "closed" && (
            <Suspense>
              <FileDiffPane
                ref={focus.fileDiffRef}
                state={fileDiff}
                diffStyle={diff.diffStyle}
                theme={appearance.variant.appearance}
                painted={Object.keys(appearance.variant.palette).length > 0}
                onDiffStyle={diff.setDiffStyle}
                onBack={app.closeFile}
                onRetry={() => app.openFile(fileDiff.path, fileDiff.side)}
                onRefresh={() => {
                  loop.rereadChanges();
                  app.openFile(fileDiff.path, fileDiff.side);
                }}
                selectable={history.shows}
                onSelectCommit={(oid) =>
                  nav.selecting.select({ kind: "commit", oid })
                }
                parts={diff.parts.view}
                writes={loop.writes}
              />
            </Suspense>
          )}
        </>
      ) : view.opening ? (
        <HistoryPlaceholder />
      ) : workspace.kind === "error" ? (
        <div className="workspace-empty">
          <div className="empty-icon error-icon">
            <TriangleAlert size={32} />
          </div>
          <h1>
            {workspace.error.kind === "timedOut"
              ? "Reading this repository took too long"
              : "Could not open this repository"}
          </h1>
          <p className="path-label">{workspace.path}</p>
          <p role="alert">{workspace.error.message}</p>
          <div className="empty-actions">
            <button
              className="button secondary"
              onClick={() => void app.selectRepository(workspace.path)}
            >
              Try again
            </button>
            <button className="button primary" onClick={onAdd}>
              Choose another folder
            </button>
          </div>
        </div>
      ) : (
        <div className="workspace-empty starter">
          <div className="empty-icon">
            <FolderGit2 size={34} strokeWidth={1.3} />
          </div>
          <span className="eyebrow">L1 Git</span>
          <h1>Open your first repository</h1>
          <p>
            Browse your branches, follow the commit graph,
            <br />
            and see the story behind each change.
          </p>
          <button className="button primary" onClick={onAdd}>
            <Plus size={16} />
            Add repository
          </button>
          <span className="empty-shortcut">
            or press <kbd>⌘ / Ctrl</kbd> <kbd>O</kbd>
          </span>
          <div className="empty-scope">
            <span className="status-dot" />
            Fetches remotes and fast-forwards only clean branches that are
            behind.
          </div>
        </div>
      )}
    </div>
  );
}
