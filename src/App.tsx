import { MergeControls } from "./components/MergeControls";
import { Suspense } from "react";
import { EyeOff, FolderGit2, Info, Plus, TriangleAlert } from "lucide-react";
import { useAppearance } from "./appearance";
import { useBranchVisibility } from "./branchVisibility";
import type { ThemeSettings } from "./themes/catalog";
import { AppearanceSettings } from "./components/AppearanceSettings";
import { GeneralSettings } from "./components/GeneralSettings";
import { SettingsDialog } from "./components/SettingsDialog";
import { CommitInspector, InspectorFrame } from "./components/CommitInspector";
import { History, HistoryPlaceholder } from "./components/History";
import { PaneDivider } from "./components/PaneDivider";
import { WriteNoticeRow } from "./components/UndoControls";
import { useExpandedRepositories } from "./expandedRepositories";
import { useUpdates } from "./updates";
import { useUpdateRestart } from "./components/UpdateRestart";
import { InstallingBlocker } from "./components/UpdatesSettings";
import { useFetchSettings } from "./fetchSettings";
import { useHistoryColumns } from "./historyColumns";
import { repositoryWarnings, useOverview } from "./overview";
import { macNative } from "./repositories";
import { useRepositoryRefs } from "./useRepositoryRefs";
import { useWorkspace } from "./useWorkspace";
import { composeActions } from "./shell/actionSlices";
import { InspectorToggle, SidebarToggle } from "./shell/LayoutToggles";
import { openedRepository, useSyncControls } from "./shell/sync";
import { PublishHost, PushNotice } from "./shell/SyncRegions";
import { useActiveWorktree } from "./shell/useActiveWorktree";
import { useFocus, useFocusRecovery } from "./shell/useFocus";
import { useHistoryPane } from "./shell/useHistoryPane";
import { useLayout } from "./shell/useLayout";
import { useDiffPane } from "./shell/useDiffPane";
import {
  DiscardHost,
  DiscardPartHost,
  AddRepositoryHost,
  PaletteHost,
  StashHost,
} from "./shell/Hosts";
import { useNavigation } from "./shell/useNavigation";
import { Sidebar } from "./shell/Sidebar";
import { Toolbar } from "./shell/Toolbar";
import { useRefWrites, useUndoSteps } from "./shell/useRefWrites";
import {
  BranchHost,
  CheckoutCommitHost,
  DropStashHost,
  EditMessageHost,
  TagHost,
} from "./shell/RefWriteHosts";
import { usePalette, useShortcuts } from "./shell/usePalette";
import { useStaging } from "./shell/useStaging";
import { useMergePanel, useResolutionDrafts } from "./shell/useMergePanel";
import {
  ResolutionDraftList,
  RetainedResolutionHost,
} from "./shell/MergeRegions";
import { useWriteLoop } from "./shell/useWriteLoop";
import { useSettingsScreen } from "./shell/useSettingsScreen";
import { FileDiffPane, usePrefetchLazyViews } from "./shell/lazyViews";
import { isBranch } from "./shell/navigation";
import { workspaceView } from "./shell/workspaceView";

export function App({ initialTheme }: { initialTheme: ThemeSettings }) {
  const appearance = useAppearance(initialTheme);
  const app = useWorkspace();
  const view = workspaceView(app);
  const { snapshot, shown, opening, busy, fileOpen, activePath } = view;
  const fetchSettings = useFetchSettings();
  const updates = useUpdates();
  const updateRestart = useUpdateRestart(updates);
  const { view: overview, store: overviewStore } = useOverview(
    app.catalog.entries.map((entry) => entry.root),
    fetchSettings.intervalMinutes,
  );
  const layout = useLayout(shown);
  const {
    sidebarOpen,
    inspectorVisible,
    inspectorWidth,
    setInspectorWidth,
    sidebarToggleRef,
  } = layout;
  const settings = useSettingsScreen(layout);
  const focus = useFocus(sidebarToggleRef);
  const { historyRef, fileDiffRef } = focus;
  const palette = usePalette(focus);
  const { workspace, current, fileDiff, closeFile } = app;
  const expansion = useExpandedRepositories(app.catalog);
  const historyColumns = useHistoryColumns();
  const visibility = useBranchVisibility();
  const persistenceError =
    app.persistenceError ??
    expansion.persistenceError ??
    historyColumns.persistenceError ??
    visibility.persistenceError;
  const branchRefs = useRepositoryRefs(
    expansion.expanded,
    workspace,
    snapshot,
    overviewStore,
    visibility.prune,
  );
  const opened = openedRepository(overview, shown?.root ?? null);
  const openRepository = opened.repository;
  const history = useHistoryPane({
    snapshot,
    ruleFor: visibility.ruleFor,
    changes: app.changes,
    statuses: openRepository?.overview.branches,
    selection: app.selection,
    focus,
  });
  const { model, rule, placement, shows } = history;
  const active = useActiveWorktree(snapshot, app.selection, app.changes);
  const loop = useWriteLoop({
    app,
    snapshotRoot: snapshot?.root ?? null,
    overview: { view: overview, store: overviewStore },
    opened,
    active,
    reloadRefs: branchRefs.reload,
  });
  const { writes, rereadChanges, refreshRepository } = loop;
  const sync = useSyncControls(
    overviewStore,
    overview,
    opened,
    loop.writes.running !== null,
  );
  const nav = useNavigation({
    app,
    view,
    history,
    visibility,
    expansion,
    sidebarRefs: branchRefs.refs,
    settings,
    focus,
    layout,
    paletteOpen: palette.open,
  });
  useFocusRecovery(focus);
  const { jumped, jumpedUnloaded, hiddenJump } = nav.jump;
  const diff = useDiffPane({ app, writes, active, focus });
  const { parts } = diff;
  const staging = useStaging({
    snapshot,
    selection: app.selection,
    compare: app.compare,
    changes: app.changes,
    writes,
    active,
    focus,
  });
  const { selectedWorktree } = staging;
  const refWrites = useRefWrites({
    snapshot,
    selection: app.selection,
    changes: app.changes,
    writes,
    nav,
    staging,
    focus,
  });
  const merge = useMergePanel({
    snapshot,
    active,
    opened,
    writes,
    rereadChanges,
    selecting: nav.selecting,
    openInspector: layout.openInspector,
  });
  const drafts = useResolutionDrafts({
    snapshot,
    closeFile,
    selectRepository: app.selectRepository,
  });
  const undo = useUndoSteps({ writes, nav, focus });
  const actions = composeActions(
    settings.actions,
    layout.actions,
    palette.actions,
    history.actions,
    nav.actions,
    sync.actions,
    loop.actions,
    diff.actions,
    staging.actions,
    refWrites.actions,
    merge.actions,
    undo.actions,
  );
  useShortcuts(actions, palette);
  usePrefetchLazyViews();
  const { commands } = actions;
  const sidebarToggle = (
    <SidebarToggle layout={layout} toggle={commands.toggleSidebar} />
  );
  const inspectorToggle = (
    <InspectorToggle
      layout={layout}
      disabled={!shown}
      toggle={commands.toggleInspector}
    />
  );

  return (
    <div
      className={`app ${macNative ? "native-mac" : ""} ${sidebarOpen ? "" : "sidebar-hidden"}`}
    >
      <Sidebar
        layout={layout}
        toggle={sidebarToggle}
        settings={settings}
        commands={commands}
        entries={app.catalog.entries}
        expansion={expansion}
        refs={branchRefs.refs}
        activePath={activePath}
        sync={overview.syncByRoot}
        navigation={nav.sidebar}
        refActions={refWrites.sidebarActions}
        updates={updates}
        restart={updateRestart}
      />
      <main className="workspace">
        <div className="repository-workspace">
          <div className="repository-content">
            <Toolbar
              sidebarToggle={sidebarToggle}
              inspectorToggle={inspectorToggle}
              layout={layout}
              shown={shown}
              snapshot={snapshot}
              writes={writes}
              sync={sync}
              commands={commands}
            />
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
            {current?.error && (
              <div className="notice error-notice" role="alert">
                <TriangleAlert size={14} />
                <span>
                  {current.error.message} The last successful view is retained.
                </span>
                <button onClick={() => void refreshRepository()}>
                  Try again
                </button>
              </div>
            )}
            {openRepository &&
              repositoryWarnings(openRepository).map((warning) => (
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
                <button
                  onClick={() => nav.showInGraph(snapshot.root, hiddenJump)}
                >
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
            <div className="workspace-panes">
              {model ? (
                <>
                  <History
                    ref={historyRef}
                    snapshot={model.snapshot}
                    visibleCommits={model.visibleCommits}
                    visibleOids={model.visibleOids}
                    rows={model.rows}
                    graph={model.graph}
                    rule={model.rule}
                    selection={app.selection}
                    compare={app.compare}
                    revealSeq={nav.revealSeq}
                    onSelect={nav.selecting.select}
                    onCompare={nav.selecting.compareWith}
                    onEndCompare={nav.selecting.endCompare}
                    onOpenFirstFile={app.openFirstFile}
                    onCancelOpen={app.cancelOpenFirstFile}
                    scrollTopOf={app.scrollTopOf}
                    onScroll={app.rememberScroll}
                    busy={busy}
                    hidden={fileOpen}
                    trunk={model.trunk}
                    visibleColumns={historyColumns.visible}
                    onToggleColumn={historyColumns.toggle}
                    editableHead={refWrites.commitActions.editableHead}
                    onEditMessage={refWrites.commitActions.onEditMessage}
                    onNewBranch={refWrites.commitActions.onNewBranch}
                    onCreateTag={refWrites.commitActions.onCreateTag}
                    onCheckout={refWrites.commitActions.onCheckout}
                  />
                  {fileDiff.kind !== "closed" && (
                    <Suspense>
                      <FileDiffPane
                        ref={fileDiffRef}
                        state={fileDiff}
                        diffStyle={diff.diffStyle}
                        theme={appearance.variant.appearance}
                        painted={
                          Object.keys(appearance.variant.palette).length > 0
                        }
                        onDiffStyle={diff.setDiffStyle}
                        onBack={closeFile}
                        onRetry={() =>
                          app.openFile(fileDiff.path, fileDiff.side)
                        }
                        onRefresh={() => {
                          rereadChanges();
                          app.openFile(fileDiff.path, fileDiff.side);
                        }}
                        selectable={shows}
                        onSelectCommit={(oid) =>
                          nav.selecting.select({ kind: "commit", oid })
                        }
                        parts={parts.view}
                        writes={writes}
                      />
                    </Suspense>
                  )}
                </>
              ) : opening ? (
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
                    <button
                      className="button primary"
                      onClick={commands.addRepository}
                    >
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
                  <button
                    className="button primary"
                    onClick={commands.addRepository}
                  >
                    <Plus size={16} />
                    Add repository
                  </button>
                  <span className="empty-shortcut">
                    or press <kbd>⌘ / Ctrl</kbd> <kbd>O</kbd>
                  </span>
                  <div className="empty-scope">
                    <span className="status-dot" />
                    Fetches remotes and fast-forwards only clean branches that
                    are behind.
                  </div>
                </div>
              )}
            </div>
          </div>
          {inspectorVisible && (
            <>
              <PaneDivider
                label="Resize commit inspector"
                width={inspectorWidth}
                min={280}
                max={500}
                direction={-1}
                onResize={setInspectorWidth}
              />
              <div
                className="inspector-container"
                style={{ width: inspectorWidth }}
              >
                {snapshot ? (
                  <CommitInspector
                    state={app.detail}
                    root={snapshot.root}
                    selection={app.selection}
                    compare={app.compare}
                    comparison={app.comparison}
                    snapshot={snapshot}
                    refs={placement.refs}
                    lane={placement.lane}
                    onSelect={nav.selecting.select}
                    onSwap={app.swapCompare}
                    selectedFile={fileDiff.kind !== "closed" ? fileDiff : null}
                    onSelectFile={app.openFile}
                    toggleButton={inspectorToggle}
                    onRetry={app.retryDetail}
                    worktree={selectedWorktree}
                    onRefreshChanges={rereadChanges}
                    writes={staging.inspectorWrites}
                  />
                ) : (
                  <InspectorFrame toggleButton={inspectorToggle} />
                )}
              </div>
            </>
          )}
        </div>
      </main>
      <RetainedResolutionHost
        drafts={drafts}
        changes={app.changes}
        appearance={appearance}
        writes={writes}
      />
      {settings.screen === "settings" && (
        <SettingsDialog
          section={settings.section}
          onSectionChange={settings.setSection}
          onClose={settings.leave}
        >
          {settings.section === "appearance" ? (
            <AppearanceSettings appearance={appearance} />
          ) : (
            <GeneralSettings
              fetching={{
                intervalMinutes: fetchSettings.intervalMinutes,
                onIntervalChange: fetchSettings.setIntervalMinutes,
                persistenceError: fetchSettings.persistenceError,
              }}
              updates={updates}
              restart={updateRestart}
            />
          )}
        </SettingsDialog>
      )}
      {updateRestart.dialog}
      <InstallingBlocker state={updates.snapshot.state} />
      <PaletteHost
        palette={palette}
        actions={actions}
        entries={app.catalog.entries}
        snapshot={snapshot}
      />
      <EditMessageHost
        refWrites={refWrites}
        writes={writes}
        nav={nav}
        focus={focus}
      />
      <PublishHost sync={sync} loop={loop} focus={focus} />
      <BranchHost
        refWrites={refWrites}
        snapshot={snapshot}
        writes={writes}
        nav={nav}
        focus={focus}
      />
      <TagHost
        refWrites={refWrites}
        snapshot={snapshot}
        writes={writes}
        nav={nav}
        focus={focus}
      />
      <CheckoutCommitHost refWrites={refWrites} />
      <StashHost staging={staging} writes={writes} />
      <DropStashHost
        refWrites={refWrites}
        snapshot={snapshot}
        writes={writes}
      />
      <DiscardHost staging={staging} writes={writes} />
      <DiscardPartHost diff={diff} />
      <AddRepositoryHost nav={nav} />
    </div>
  );
}
