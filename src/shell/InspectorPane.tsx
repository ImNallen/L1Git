import type { ReactNode } from "react";
import { CommitInspector, InspectorFrame } from "../components/CommitInspector";
import { PaneDivider } from "../components/PaneDivider";
import type { RepositorySnapshot } from "../domain/repository";
import type { HistoryPane } from "./useHistoryPane";
import type { Layout } from "./useLayout";
import type { Navigation } from "./useNavigation";
import type { Staging } from "./useStaging";
import type { WorkspaceApi } from "./workspaceView";

export function InspectorPane({
  layout,
  toggle,
  app,
  snapshot,
  nav,
  history,
  staging,
  rereadChanges,
}: {
  layout: Pick<
    Layout,
    "inspectorVisible" | "inspectorWidth" | "setInspectorWidth"
  >;
  toggle: ReactNode;
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
        width={layout.inspectorWidth}
        min={280}
        max={500}
        direction={-1}
        onResize={layout.setInspectorWidth}
      />
      <div
        className="inspector-container"
        style={{ width: layout.inspectorWidth }}
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
            toggleButton={toggle}
            onRetry={app.retryDetail}
            worktree={staging.selectedWorktree}
            onRefreshChanges={rereadChanges}
            writes={staging.inspectorWrites}
          />
        ) : (
          <InspectorFrame toggleButton={toggle} />
        )}
      </div>
    </>
  );
}
