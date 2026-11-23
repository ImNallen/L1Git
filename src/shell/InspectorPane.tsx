import { CommitInspector, InspectorFrame } from "../components/CommitInspector";
import { PaneDivider } from "../components/PaneDivider";
import type { RepositorySnapshot } from "../domain/repository";
import type { HistoryPane } from "./useHistoryPane";
import { INSPECTOR_WIDTH } from "./useLayout";
import type { Layout } from "./useLayout";
import type { Navigation } from "./useNavigation";
import type { Staging } from "./useStaging";
import type { WorkspaceApi } from "./workspaceView";

export function InspectorPane({
  layout,
  app,
  snapshot,
  nav,
  history,
  staging,
  rereadChanges,
}: {
  layout: Pick<
    Layout,
    "inspectorVisible" | "paneWidths" | "resizePane" | "savePaneWidth"
  >;
  app: WorkspaceApi;
  snapshot: RepositorySnapshot | null;
  nav: Pick<Navigation, "selecting">;
  history: Pick<HistoryPane, "placement">;
  staging: Pick<Staging, "selectedWorktree" | "inspectorWrites">;
  rereadChanges: () => void;
}) {
  if (!layout.inspectorVisible) return null;
  const { fileDiff } = app;
  return (
    <>
      <PaneDivider
        label="Resize commit inspector"
        width={layout.paneWidths.inspector}
        min={INSPECTOR_WIDTH.min}
        max={INSPECTOR_WIDTH.max}
        direction={-1}
        onResize={(width) => layout.resizePane("inspector", width)}
        onResizeEnd={(width) => layout.savePaneWidth("inspector", width)}
      />
      <div
        className="inspector-container"
        style={{ width: layout.paneWidths.inspector }}
      >
        {snapshot ? (
          <CommitInspector
            state={app.detail}
            root={snapshot.root}
            selecting={nav.selecting}
            comparison={app.comparison}
            snapshot={snapshot}
            placement={history.placement}
            selectedFile={fileDiff.kind !== "closed" ? fileDiff : null}
            onSelectFile={app.openFile}
            onRetry={app.retryDetail}
            worktree={staging.selectedWorktree}
            onRefreshChanges={rereadChanges}
            writes={staging.inspectorWrites}
          />
        ) : (
          <InspectorFrame />
        )}
      </div>
    </>
  );
}
