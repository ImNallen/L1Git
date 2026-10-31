import { useAppearance } from "./appearance";
import { useBranchVisibility } from "./branchVisibility";
import type { ThemeSettings } from "./themes/catalog";
import { AppearanceSettings } from "./components/AppearanceSettings";
import { GeneralSettings } from "./components/GeneralSettings";
import { SettingsDialog } from "./components/SettingsDialog";
import { CommitInspector, InspectorFrame } from "./components/CommitInspector";
import { PaneDivider } from "./components/PaneDivider";
import { useExpandedRepositories } from "./expandedRepositories";
import { useUpdates } from "./updates";
import { useUpdateRestart } from "./components/UpdateRestart";
import { InstallingBlocker } from "./components/UpdatesSettings";
import { useFetchSettings } from "./fetchSettings";
import { useHistoryColumns } from "./historyColumns";
import { useOverview } from "./overview";
import { macNative } from "./repositories";
import { useRepositoryRefs } from "./useRepositoryRefs";
import { useWorkspace } from "./useWorkspace";
import { composeActions } from "./shell/actionSlices";
import { InspectorToggle, SidebarToggle } from "./shell/LayoutToggles";
import { openedRepository, useSyncControls } from "./shell/sync";
import { PublishHost } from "./shell/SyncRegions";
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
import { Notices } from "./shell/Notices";
import { WorkspacePanes } from "./shell/WorkspacePanes";
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
import { RetainedResolutionHost } from "./shell/MergeRegions";
import { useWriteLoop } from "./shell/useWriteLoop";
import { useSettingsScreen } from "./shell/useSettingsScreen";
import { usePrefetchLazyViews } from "./shell/lazyViews";
import { workspaceView } from "./shell/workspaceView";

export function App({ initialTheme }: { initialTheme: ThemeSettings }) {
  const appearance = useAppearance(initialTheme);
  const app = useWorkspace();
  const view = workspaceView(app);
  const { snapshot, shown, activePath } = view;
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
  const { rule, placement } = history;
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
  const diff = useDiffPane({ app, writes, active, focus });
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
            <Notices
              snapshot={snapshot}
              writes={writes}
              merge={merge}
              drafts={drafts}
              sync={sync}
              persistenceError={persistenceError}
              error={current?.error}
              onRetry={() => void refreshRepository()}
              rule={rule}
              nav={nav}
            />
            <WorkspacePanes
              app={app}
              view={view}
              history={history}
              columns={historyColumns}
              nav={nav}
              commitActions={refWrites.commitActions}
              focus={focus}
              diff={diff}
              loop={loop}
              appearance={appearance}
              onAdd={commands.addRepository}
            />
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
