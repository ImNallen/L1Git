import { isPainted, useAppearance } from "./appearance";
import { useBranchVisibility } from "./branchVisibility";
import { PullRequests } from "./components/PullRequests";
import { useUpdateRestart } from "./components/UpdateRestart";
import { useExpandedRepositories } from "./expandedRepositories";
import { useFetchSettings } from "./fetchSettings";
import { useHost } from "./host";
import { useLaunchSplash } from "./launchSplash";
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
  RemoveWorktreeHost,
  TagHost,
  TryLocallyHost,
} from "./shell/RefWriteHosts";
import { Sidebar } from "./shell/Sidebar";
import { openedRepository, useSyncControls } from "./shell/sync";
import { PublishHost } from "./shell/SyncRegions";
import { Toolbar } from "./shell/Toolbar";
import { useActiveWorktree } from "./shell/useActiveWorktree";
import { useDiffPane } from "./shell/useDiffPane";
import { useFilesChanged } from "./shell/useFilesChanged";
import { useFocus, useFocusRecovery } from "./shell/useFocus";
import { useHistoryPane } from "./shell/useHistoryPane";
import { useLayout } from "./shell/useLayout";
import { useMergePanel } from "./shell/useMergePanel";
import { useResolutionDrafts } from "./shell/useResolutionDrafts";
import { useNavigation } from "./shell/useNavigation";
import { usePalette, useShortcuts } from "./shell/usePalette";
import { usePullRequests } from "./shell/usePullRequests";
import { useRefWrites, useUndoSteps } from "./shell/useRefWrites";
import { useScreen } from "./shell/useScreen";
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
  const host = useHost();
  const overview = useOverview(
    app.catalog.entries.map((entry) => entry.root),
    fetchSettings.intervalMinutes,
  );
  const layout = useLayout(view.shown);
  const screen = useScreen(layout);
  const focus = useFocus(layout.sidebarToggleRef);
  const pulls = usePullRequests({
    host,
    entries: app.catalog.entries,
    overview: overview.view,
    intervalMinutes: fetchSettings.intervalMinutes,
    screen,
    focus,
    layout,
  });
  const files = useFilesChanged({ opened: pulls.opened, screen });
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
  const nav = useNavigation({
    app,
    view,
    history,
    visibility,
    expansion,
    sidebarRefs: sidebarRefs.refs,
    screen,
    focus,
    layout,
    paletteOpen: palette.open,
  });
  // After navigation: its ref-step effect must see lost focus before this restores it.
  useFocusRecovery(focus);
  const sync = useSyncControls({
    store: overview.store,
    view: overview.view,
    opened,
    writing: writes.running !== null,
    snapshot: view.snapshot,
    activeRoot: active.root,
    selectedBranch: nav.jump.ruledBranch,
    post: writes.post,
  });
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
    saved: app,
  });
  const merge = useMergePanel({
    selectedBranch: nav.jump.ruledBranch,
    selection: app.selection,
    snapshot: view.snapshot,
    active,
    opened,
    writes,
    rereadChanges: loop.rereadChanges,
    selecting: nav.selecting,
    openInspector: layout.openInspector,
    openFirstFile: app.openFirstFile,
    pull: overview.store.pull,
  });
  const drafts = useResolutionDrafts({
    snapshot: view.snapshot,
    closeFile: app.closeFile,
    selectRepository: app.selectRepository,
  });
  const undo = useUndoSteps({ writes, nav, focus });
  const actions = composeActions(
    screen.actions,
    pulls.actions,
    files.actions,
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
  useLaunchSplash(
    app.catalog.lastRoot === null ||
      app.workspace.kind === "ready" ||
      app.workspace.kind === "error",
  );

  const { commands } = actions;
  const onPulls = screen.place === "pullRequests";
  const inspectorShown = onPulls
    ? pulls.opened !== null && layout.inspectorOpen
    : layout.inspectorVisible;
  const persistenceError =
    app.persistenceError ??
    expansion.persistenceError ??
    columns.persistenceError ??
    visibility.persistenceError ??
    layout.persistenceError ??
    files.persistenceError;

  return (
    <div
      className={`app ${macNative ? "native-mac" : ""} ${layout.sidebarOpen ? "" : "sidebar-hidden"} ${inspectorShown ? "" : "inspector-hidden"}`}
    >
      <SidebarToggle layout={layout} toggle={commands.toggleSidebar} />
      <Sidebar
        layout={layout}
        screen={screen}
        pulls={pulls}
        commands={commands}
        entries={app.catalog.entries}
        expansion={expansion}
        refs={sidebarRefs.refs}
        activePath={view.activePath}
        sync={overview.view.syncByRoot}
        operations={overview.view.operations}
        navigation={nav.sidebar}
        refActions={{
          ...refWrites.sidebarActions,
          merge: merge.sidebar,
          fastForward: sync.sidebar,
        }}
        updates={updates}
        restart={restart}
      />
      <main className="workspace">
        {pulls.visited && (
          <PullRequests
            ref={focus.pullRequestsRef}
            hidden={!onPulls}
            status={host.status}
            hostProblem={host.problem}
            onCheckHost={() => void host.refresh()}
            state={pulls}
            files={files}
            layout={layout}
            theme={appearance.variant.appearance}
            painted={isPainted(appearance.variant)}
            onSignIn={() => commands.openSettings("hosts")}
            onBack={commands.closePullRequest}
            onLeave={commands.showHistory}
          />
        )}
        <div className="repository-workspace" hidden={onPulls}>
          <div className="repository-content">
            <Toolbar
              actions={actions}
              searchSlot={layout.setSearchSlot}
              layout={layout}
              shown={view.shown}
              snapshot={view.snapshot}
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
              worktree={{ refWrites, open: commands.openRepository }}
            />
            <WorkspacePanes
              searchSlot={layout.searchSlot}
              app={app}
              view={view}
              history={history}
              columns={columns}
              nav={nav}
              commitActions={refWrites.commitActions}
              commitReplay={merge.commitReplay}
              focus={focus}
              diff={diff}
              loop={loop}
              appearance={appearance}
              onAdd={commands.addRepository}
            />
          </div>
          <InspectorPane
            layout={layout}
            app={app}
            snapshot={view.snapshot}
            nav={nav}
            history={history}
            staging={staging}
            rereadChanges={loop.rereadChanges}
          />
        </div>
      </main>
      {(!onPulls || pulls.opened) && (
        <InspectorToggle
          layout={layout}
          label={
            onPulls ? "Toggle pull request details" : "Toggle commit inspector"
          }
          visible={inspectorShown}
          disabled={!onPulls && !view.shown}
          toggle={commands.toggleInspector}
        />
      )}
      {/* Overlays in this order, so dialogs opened in one commit stack as before. */}
      <RetainedResolutionHost
        drafts={drafts}
        changes={app.changes}
        appearance={appearance}
        writes={writes}
      />
      <SettingsHost
        settings={screen}
        appearance={appearance}
        fetching={fetchSettings}
        updates={updates}
        restart={restart}
        host={host}
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
      <TryLocallyHost
        refWrites={refWrites}
        snapshot={view.snapshot}
        focus={focus}
      />
      <RemoveWorktreeHost refWrites={refWrites} />
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
