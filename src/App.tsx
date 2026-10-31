import { MergeControls } from "./components/MergeControls";
import { Suspense, useState } from "react";
import { flushSync } from "react-dom";
import {
  EyeOff,
  FolderGit2,
  Info,
  Settings,
  Plus,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { REDO_SHORTCUT, shortcutLabel, UNDO_SHORTCUT } from "./actions";
import { useAppearance } from "./appearance";
import { useBranchVisibility } from "./branchVisibility";
import type { ThemeSettings } from "./themes/catalog";
import { AppearanceSettings } from "./components/AppearanceSettings";
import { BranchDialog } from "./components/BranchDialog";
import { CheckoutCommitDialog } from "./components/CheckoutCommitDialog";
import { TagDialog } from "./components/TagDialog";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { EditMessageDialog } from "./components/EditMessageDialog";
import { GeneralSettings } from "./components/GeneralSettings";
import { SettingsDialog } from "./components/SettingsDialog";
import { CommitInspector, InspectorFrame } from "./components/CommitInspector";
import { History, HistoryPlaceholder } from "./components/History";
import { PaneDivider } from "./components/PaneDivider";
import { RepositoryTree } from "./components/RepositoryTree";
import { UndoButtons, WriteNoticeRow } from "./components/UndoControls";
import {
  answeredInTagDialog,
  branchAsks,
  checkoutWrite,
  nextEntry,
  refStep,
  startAt,
  stashApplyWrite,
  stashDropWrite,
  stashPopWrite,
  worktreeForStash,
} from "./domain/operations";
import type { BranchAsk, Step, TagAsk } from "./domain/operations";
import type { Oid, Start, Stash } from "./domain/repository";
import { useExpandedRepositories } from "./expandedRepositories";
import { useUpdates } from "./updates";
import { useUpdateRestart } from "./components/UpdateRestart";
import {
  UpdateAffordance,
  InstallingBlocker,
} from "./components/UpdatesSettings";
import { useFetchSettings } from "./fetchSettings";
import { useHistoryColumns } from "./historyColumns";
import { repositoryWarnings, useOverview } from "./overview";
import { mac, macNative } from "./repositories";
import { useRepositoryRefs } from "./useRepositoryRefs";
import { useWorkspace } from "./useWorkspace";
import { composeActions, defineSlice } from "./shell/actionSlices";
import { focusedElement, shownElement } from "./shell/dom";
import { InspectorToggle, SidebarToggle } from "./shell/LayoutToggles";
import { openedRepository, useSyncControls } from "./shell/sync";
import { PublishHost, PushNotice, SyncButtons } from "./shell/SyncRegions";
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
    sidebarWidth,
    setSidebarWidth,
    inspectorWidth,
    setInspectorWidth,
    sidebarToggleRef,
  } = layout;
  const settings = useSettingsScreen(layout);
  const focus = useFocus(sidebarToggleRef);
  const {
    historyRef,
    fileDiffRef,
    fallback: focusFallback,
    focusNamedBranch,
    refocusIfLost,
  } = focus;
  const palette = usePalette(focus);
  const [editingMessage, setEditingMessage] = useState(false);
  const [branchAsk, setBranchAsk] = useState<BranchAsk | null>(null);
  const [detaching, setDetaching] = useState<Oid | null>(null);
  const [tagAsk, setTagAsk] = useState<TagAsk | null>(null);
  const [droppingStash, setDroppingStash] = useState<Stash | null>(null);
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
  const selected = app.selection;
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
  const { jumped, jumpedUnloaded, hiddenJump, ruledBranch, sidebarTag } =
    nav.jump;
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
  function stashAction(action: "apply" | "pop" | "drop", stash: Stash) {
    if (!snapshot) return;
    if (action === "drop") {
      setDroppingStash(stash);
      return;
    }
    const target = worktreeForStash(
      snapshot,
      stash.message,
      selectedWorktree
        ? {
            root: selectedWorktree.worktree.root,
            head: selectedWorktree.worktree.head,
          }
        : null,
    );
    const write =
      action === "apply"
        ? stashApplyWrite(stash, target.head)
        : stashPopWrite(stash, target.head);
    void writes.write(target.root, write);
  }
  const rootChanges = snapshot ? app.changes.get(snapshot.root) : undefined;
  const headStatus = rootChanges?.kind === "ready" ? rootChanges.status : null;
  const editableHead =
    headStatus?.head.kind === "unborn" ? null : (headStatus?.head.oid ?? null);
  const askFor = (kind: keyof ReturnType<typeof branchAsks>) => () => {
    const ask = ruledBranch && branchAsks(ruledBranch)[kind];
    if (ask) setBranchAsk(ask);
  };
  const askTag = (oid: Oid) =>
    setTagAsk({
      kind: "create",
      at: oid,
      subject:
        snapshot?.commits.find((commit) => commit.oid === oid)?.subject ?? "",
    });
  const refWriteActions = defineSlice({
    context: {},
    commands: {
      checkout: () => {
        if (ruledBranch) void checkout(startAt(ruledBranch));
      },
      newBranch: askFor("create"),
      renameBranch: askFor("rename"),
      deleteBranch: askFor("delete"),
      createTag: () => {
        if (selected?.kind === "commit") askTag(selected.oid);
      },
      deleteTag: () => {
        if (sidebarTag) setTagAsk({ kind: "delete", tag: sidebarTag });
      },
    },
  });
  const undoActions = defineSlice({
    context: {
      history: {
        undo: nextEntry(writes.history, "undo")?.label ?? null,
        redo: nextEntry(writes.history, "redo")?.label ?? null,
      },
    },
    commands: {
      undo: () => void stepHistory("undo"),
      redo: () => void stepHistory("redo"),
    },
  });
  async function checkout(target: Start) {
    if (!snapshot) return;
    await writes.write(snapshot.root, checkoutWrite(target, snapshot.head));
    refocusIfLost();
  }
  async function stepHistory(step: Step) {
    const entry = nextEntry(writes.history, step);
    nav.followRefStep(null);
    const outcome = await writes[step]();
    if (entry?.operation.kind === "checkout") refocusIfLost();
    const moved = entry && refStep(entry.operation, step);
    if (outcome.kind === "applied" && entry && moved)
      nav.followRefStep({ root: entry.root, ...moved });
  }
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
    refWriteActions,
    merge.actions,
    undoActions,
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
      <aside
        hidden={!sidebarOpen}
        className="sidebar"
        style={{ width: sidebarWidth }}
        aria-label="Repository sidebar"
      >
        <div className="brand" data-tauri-drag-region>
          {sidebarOpen && sidebarToggle}
          <span data-tauri-drag-region>
            L1{" "}
            <span className="muted" data-tauri-drag-region>
              Git
            </span>
          </span>
        </div>
        <div className="repository-navigation">
          <RepositoryTree
            entries={app.catalog.entries}
            expanded={expansion.expanded}
            refs={branchRefs.refs}
            activePath={activePath}
            highlighted={nav.sidebar.highlighted}
            selectedStash={nav.sidebar.selectedStash}
            sync={overview.syncByRoot}
            onSelect={nav.sidebar.onSelect}
            onToggle={(root) =>
              expansion.setExpanded(root, !expansion.expanded.has(root))
            }
            onJump={nav.sidebar.onJump}
            onStash={nav.sidebar.onStash}
            ruleFor={nav.sidebar.ruleFor}
            onRule={nav.sidebar.onRule}
            onRemove={nav.sidebar.onRemove}
            onAdd={nav.sidebar.onAdd}
            writable={
              snapshot && { root: snapshot.root, checkedOutIn: nav.checkedOut }
            }
            onBranchAsk={setBranchAsk}
            onTagAsk={setTagAsk}
            onStashAction={stashAction}
            onCheckout={(branch) => void checkout(startAt(branch))}
          />
        </div>
        <footer className="sidebar-bottom">
          <button
            ref={settings.settingsRef}
            className="icon-button"
            aria-label="Settings"
            title="Settings"
            onClick={() => commands.openSettings()}
          >
            <Settings size={16} />
          </button>
          <UpdateAffordance updates={updates} restart={updateRestart} />
        </footer>
      </aside>
      {sidebarOpen && (
        <PaneDivider
          label="Resize repository sidebar"
          width={sidebarWidth}
          min={210}
          max={400}
          direction={1}
          onResize={setSidebarWidth}
        />
      )}
      <main className="workspace">
        <div className="repository-workspace">
          <div className="repository-content">
            <header className="toolbar" data-tauri-drag-region>
              {!sidebarOpen && sidebarToggle}
              <div className="breadcrumb" data-tauri-drag-region>
                {shown ? (
                  <span className="repository-name" title={shown.root}>
                    {shown.name}
                  </span>
                ) : (
                  <span className="muted">Workspace</span>
                )}
              </div>
              <div className="toolbar-actions">
                {snapshot && (
                  <UndoButtons
                    writes={writes}
                    shortcuts={{
                      undo: shortcutLabel(UNDO_SHORTCUT, mac),
                      redo: shortcutLabel(REDO_SHORTCUT, mac),
                    }}
                  />
                )}
                <SyncButtons sync={sync} commands={commands} />
                {!inspectorVisible && inspectorToggle}
              </div>
            </header>
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
                    editableHead={editableHead}
                    onEditMessage={() => setEditingMessage(true)}
                    onNewBranch={(oid) =>
                      setBranchAsk({
                        kind: "create",
                        at: { kind: "commit", oid },
                        from: `commit ${oid.slice(0, 7)}`,
                      })
                    }
                    onCreateTag={askTag}
                    onCheckout={setDetaching}
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
      {editingMessage && headStatus && editableHead && (
        <EditMessageDialog
          status={headStatus}
          onSave={async (worktree, write) => {
            const outcome = await writes.write(worktree, write);
            if (outcome.kind === "applied") nav.selectHeadAfter(worktree);
            return outcome;
          }}
          onClose={() => {
            flushSync(() => setEditingMessage(false));
            focusFallback();
          }}
        />
      )}
      <PublishHost sync={sync} loop={loop} focus={focus} />
      {branchAsk && snapshot && (
        <BranchDialog
          ask={branchAsk}
          root={snapshot.root}
          head={snapshot.head}
          onWrite={async (write) => {
            const outcome = await writes.write(snapshot.root, write);
            const shownInDialog =
              write.operation.kind === "createBranch" ||
              write.operation.kind === "renameBranch";
            if (outcome.kind === "failed" && shownInDialog) writes.dismiss();
            if (!shownElement(focusedElement())) focusFallback();
            return outcome;
          }}
          onNamedBranch={(branch) => nav.jumpTo(snapshot.root, branch)}
          onClose={() => {
            setBranchAsk(null);
            requestAnimationFrame(focusNamedBranch);
          }}
        />
      )}
      {tagAsk && snapshot && (
        <TagDialog
          ask={tagAsk}
          head={snapshot.head}
          onWrite={async (write) => {
            const { operation } = write;
            const outcome = await writes.write(snapshot.root, write);
            if (
              outcome.kind === "failed" &&
              operation.kind === "createTag" &&
              answeredInTagDialog(outcome.problem)
            )
              writes.dismiss();
            if (outcome.kind === "applied" && operation.kind === "deleteTag")
              nav.followRefStep({
                root: snapshot.root,
                left: null,
                gone: operation.tag.reference,
              });
            return outcome;
          }}
          onClose={() => {
            setTagAsk(null);
            refocusIfLost();
          }}
        />
      )}
      {detaching && (
        <CheckoutCommitDialog
          oid={detaching}
          onConfirm={() => void checkout({ kind: "commit", oid: detaching })}
          onClose={() => setDetaching(null)}
        />
      )}
      <StashHost staging={staging} writes={writes} />
      {droppingStash && snapshot && (
        <ConfirmDialog
          icon={Trash2}
          title={`Drop ${droppingStash.name}?`}
          closeLabel="Close drop stash"
          confirm="Drop stash"
          onConfirm={() => {
            void writes.write(
              snapshot.root,
              stashDropWrite(droppingStash, snapshot.head),
            );
            setDroppingStash(null);
          }}
          onClose={() => setDroppingStash(null)}
        >
          <p>
            {droppingStash.message} Undo puts this entry back at stash@{"{0}"}.
          </p>
        </ConfirmDialog>
      )}
      <DiscardHost staging={staging} writes={writes} />
      <DiscardPartHost diff={diff} />
      <AddRepositoryHost nav={nav} />
    </div>
  );
}
