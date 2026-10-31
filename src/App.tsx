import { useAppearance } from "./appearance";
import { useBranchVisibility } from "./branchVisibility";
import { useUpdateRestart } from "./components/UpdateRestart";
import { useExpandedRepositories } from "./expandedRepositories";
import { useFetchSettings } from "./fetchSettings";
import { useHistoryColumns } from "./historyColumns";
import { useOverview } from "./overview";
import { macNative } from "./repositories";
import type { ThemeSettings } from "./themes/catalog";
import { useUpdates } from "./updates";
import { useRepositoryRefs } from "./useRepositoryRefs";
import { useWorkspace } from "./useWorkspace";
import { composeActions } from "./shell/actionSlices";
import {
  AddRepositoryHost,
  DiscardHost,
  DiscardPartHost,
  PaletteHost,
  SettingsHost,
  StashHost,
} from "./shell/Hosts";
import { InspectorPane } from "./shell/InspectorPane";
import { InspectorToggle, SidebarToggle } from "./shell/LayoutToggles";
import { usePrefetchLazyViews } from "./shell/lazyViews";
import { RetainedResolutionHost } from "./shell/MergeRegions";
import { Notices } from "./shell/Notices";
import {
  BranchHost,
  CheckoutCommitHost,
  DropStashHost,
  EditMessageHost,
  TagHost,
} from "./shell/RefWriteHosts";
import { Sidebar } from "./shell/Sidebar";
import { openedRepository, useSyncControls } from "./shell/sync";
import { PublishHost } from "./shell/SyncRegions";
import { Toolbar } from "./shell/Toolbar";
import { useActiveWorktree } from "./shell/useActiveWorktree";
import { useDiffPane } from "./shell/useDiffPane";
import { useFocus, useFocusRecovery } from "./shell/useFocus";
import { useHistoryPane } from "./shell/useHistoryPane";
import { useLayout } from "./shell/useLayout";
import { useMergePanel, useResolutionDrafts } from "./shell/useMergePanel";
import { useNavigation } from "./shell/useNavigation";
import { usePalette, useShortcuts } from "./shell/usePalette";
import { useRefWrites, useUndoSteps } from "./shell/useRefWrites";
import { useSettingsScreen } from "./shell/useSettingsScreen";
import { useStaging } from "./shell/useStaging";
import { useWriteLoop } from "./shell/useWriteLoop";
import { workspaceView } from "./shell/workspaceView";
import { WorkspacePanes } from "./shell/WorkspacePanes";

/**
 * The composition root. Every owner is a hook called here, so all state stays
 * in this fiber and the order of these calls is the order effects run in.
 */
export function App({ initialTheme }: { initialTheme: ThemeSettings }) {
  const appearance = useAppearance(initialTheme);
  const app = useWorkspace();
  const view = workspaceView(app);
  const fetchSettings = useFetchSettings();
  const updates = useUpdates();
  const restart = useUpdateRestart(updates);
  const overview = useOverview(
    app.catalog.entries.map((entry) => entry.root),
    fetchSettings.intervalMinutes,
  );
  const layout = useLayout(view.shown);
  const settings = useSettingsScreen(layout);
  const focus = useFocus(layout.sidebarToggleRef);
  const palette = usePalette(focus);
  const expansion = useExpandedRepositories(app.catalog);
  const columns = useHistoryColumns();
  const visibility = useBranchVisibility();
  const sidebarRefs = useRepositoryRefs(
    expansion.expanded,
    app.workspace,
    view.snapshot,
    overview.store,
    visibility.prune,
  );
  const opened = openedRepository(overview.view, view.shown?.root ?? null);
  const history = useHistoryPane({
    snapshot: view.snapshot,
    ruleFor: visibility.ruleFor,
    changes: app.changes,
    statuses: opened.repository?.overview.branches,
    selection: app.selection,
    focus,
  });
  const active = useActiveWorktree(view.snapshot, app.selection, app.changes);
  const loop = useWriteLoop({
    app,
    snapshotRoot: view.snapshot?.root ?? null,
    overview,
    opened,
    active,
    reloadRefs: sidebarRefs.reload,
  });
  const { writes } = loop;
  const sync = useSyncControls(
    overview.store,
    overview.view,
    opened,
    writes.running !== null,
  );
  const nav = useNavigation({
    app,
    view,
    history,
    visibility,
    expansion,
    sidebarRefs: sidebarRefs.refs,
    settings,
    focus,
    layout,
    paletteOpen: palette.open,
  });
  // After navigation: its ref-step effect must see lost focus before this restores it.
  useFocusRecovery(focus);
  const diff = useDiffPane({ app, writes, active, focus });
  const staging = useStaging({
    snapshot: view.snapshot,
    selection: app.selection,
    compare: app.compare,
    changes: app.changes,
    writes,
    active,
    focus,
  });
  const refWrites = useRefWrites({
    snapshot: view.snapshot,
    selection: app.selection,
    changes: app.changes,
    writes,
    nav,
    staging,
    focus,
  });
  const merge = useMergePanel({
    snapshot: view.snapshot,
    active,
    opened,
    writes,
    rereadChanges: loop.rereadChanges,
    selecting: nav.selecting,
    openInspector: layout.openInspector,
  });
  const drafts = useResolutionDrafts({
    snapshot: view.snapshot,
    closeFile: app.closeFile,
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
      disabled={!view.shown}
      toggle={commands.toggleInspector}
    />
  );
  const persistenceError =
    app.persistenceError ??
    expansion.persistenceError ??
    columns.persistenceError ??
    visibility.persistenceError;

  return (
    <div
      className={`app ${macNative ? "native-mac" : ""} ${layout.sidebarOpen ? "" : "sidebar-hidden"}`}
    >
      <Sidebar
        layout={layout}
        toggle={sidebarToggle}
        settings={settings}
        commands={commands}
        entries={app.catalog.entries}
        expansion={expansion}
        refs={sidebarRefs.refs}
        activePath={view.activePath}
        sync={overview.view.syncByRoot}
        navigation={nav.sidebar}
        refActions={refWrites.sidebarActions}
        updates={updates}
        restart={restart}
      />
      <main className="workspace">
        <div className="repository-workspace">
          <div className="repository-content">
            <Toolbar
              sidebarToggle={sidebarToggle}
              inspectorToggle={inspectorToggle}
              layout={layout}
              shown={view.shown}
              snapshot={view.snapshot}
              writes={writes}
              sync={sync}
              commands={commands}
            />
            <Notices
              snapshot={view.snapshot}
              writes={writes}
              merge={merge}
              drafts={drafts}
              sync={sync}
              persistenceError={persistenceError}
              error={app.current?.error}
              onRetry={() => void loop.refreshRepository()}
              rule={history.rule}
              nav={nav}
            />
            <WorkspacePanes
              app={app}
              view={view}
              history={history}
              columns={columns}
              nav={nav}
              commitActions={refWrites.commitActions}
              focus={focus}
              diff={diff}
              loop={loop}
              appearance={appearance}
              onAdd={commands.addRepository}
            />
          </div>
          <InspectorPane
            layout={layout}
            toggle={inspectorToggle}
            app={app}
            snapshot={view.snapshot}
            nav={nav}
            history={history}
            staging={staging}
            rereadChanges={loop.rereadChanges}
          />
        </div>
      </main>
      {/* Overlays in this order, so dialogs opened in one commit stack as before. */}
      <RetainedResolutionHost
        drafts={drafts}
        changes={app.changes}
        appearance={appearance}
        writes={writes}
      />
      <SettingsHost
        settings={settings}
        appearance={appearance}
        fetching={fetchSettings}
        updates={updates}
        restart={restart}
      />
      <PaletteHost
        palette={palette}
        actions={actions}
        entries={app.catalog.entries}
        snapshot={view.snapshot}
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
        snapshot={view.snapshot}
        writes={writes}
        nav={nav}
        focus={focus}
      />
      <TagHost
        refWrites={refWrites}
        snapshot={view.snapshot}
        writes={writes}
        nav={nav}
        focus={focus}
      />
      <CheckoutCommitHost refWrites={refWrites} />
      <StashHost staging={staging} writes={writes} />
      <DropStashHost
        refWrites={refWrites}
        snapshot={view.snapshot}
        writes={writes}
      />
      <DiscardHost staging={staging} writes={writes} />
      <DiscardPartHost diff={diff} />
      <AddRepositoryHost nav={nav} />
    </div>
  );
}
