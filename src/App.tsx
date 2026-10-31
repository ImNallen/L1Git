import { MergeControls } from "./components/MergeControls";
import {
  Suspense,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
import {
  claimedWhilePaletteOpen,
  matchesShortcut,
  PALETTE_SHORTCUT,
  paletteItems,
  REDO_SHORTCUT,
  shortcutAction,
  shortcutLabel,
  typingIn,
  UNDO_SHORTCUT,
} from "./actions";
import type { PaletteItem } from "./actions";
import { useAppearance } from "./appearance";
import { useBranchVisibility } from "./branchVisibility";
import type { ThemeSettings } from "./themes/catalog";
import { AppearanceSettings } from "./components/AppearanceSettings";
import { AddRepositoryDialog } from "./components/AddRepositoryDialog";
import { BranchDialog } from "./components/BranchDialog";
import { CheckoutCommitDialog } from "./components/CheckoutCommitDialog";
import { TagDialog } from "./components/TagDialog";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { EditMessageDialog } from "./components/EditMessageDialog";
import { CommandPalette } from "./components/CommandPalette";
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
import type { BranchAsk, RefStep, Step, TagAsk } from "./domain/operations";
import { swapEnds } from "./domain/comparison";
import type {
  FullRef,
  Oid,
  RepositoryRoot,
  Start,
  Stash,
} from "./domain/repository";
import type { Compare } from "./domain/comparison";
import type { Selection } from "./domain/selection";
import { branchVisibility, NO_RULE, toggleRule } from "./domain/visibility";
import type { VisibilityRule } from "./domain/visibility";
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
import { DiscardHost, DiscardPartHost, StashHost } from "./shell/Hosts";
import { useStaging } from "./shell/useStaging";
import { useMergePanel, useResolutionDrafts } from "./shell/useMergePanel";
import {
  ResolutionDraftList,
  RetainedResolutionHost,
} from "./shell/MergeRegions";
import { useWriteLoop } from "./shell/useWriteLoop";
import { useSettingsScreen } from "./shell/useSettingsScreen";
import { FileDiffPane, usePrefetchLazyViews } from "./shell/lazyViews";
import { isBranch, jumpView, listedRef } from "./shell/navigation";
import { workspaceView } from "./shell/workspaceView";
import type { Jump, JumpTarget } from "./shell/navigation";

export function App({ initialTheme }: { initialTheme: ThemeSettings }) {
  const appearance = useAppearance(initialTheme);
  const app = useWorkspace();
  const view = workspaceView(app);
  const { snapshot, settled, shown, opening, busy, fileOpen, activePath } =
    view;
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
  const [adding, setAdding] = useState(false);
  const [editingMessage, setEditingMessage] = useState(false);
  const [headOf, setHeadOf] = useState<RepositoryRoot | null>(null);
  const [branchAsk, setBranchAsk] = useState<BranchAsk | null>(null);
  const [detaching, setDetaching] = useState<Oid | null>(null);
  const [tagAsk, setTagAsk] = useState<TagAsk | null>(null);
  const [droppingStash, setDroppingStash] = useState<Stash | null>(null);
  const [steppedRef, setSteppedRef] = useState<
    (RefStep & { root: RepositoryRoot }) | null
  >(null);
  const focusJumpedRow = useRef(false);
  const [palette, setPalette] = useState<{ picked: Oid | null } | null>(null);
  const paletteReturn = useRef<Element | null>(null);
  const [jump, setJump] = useState<Jump | null>(null);
  // The branch or tag last selected in each repository, so it stays highlighted after a round trip.
  const [lastBranch, setLastBranch] = useState<
    ReadonlyMap<RepositoryRoot, FullRef>
  >(new Map());
  const gridFocus = useRef<{
    root: RepositoryRoot;
    from: Element | null;
    cancel: AbortController;
  } | null>(null);
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
  const { model, rule, loaded, visibleOids, placement, shows } = history;
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
  const merge = useMergePanel({
    snapshot,
    active,
    opened,
    writes,
    rereadChanges,
    selecting: { select },
    openInspector: layout.openInspector,
  });
  const drafts = useResolutionDrafts({
    snapshot,
    closeFile,
    selectRepository: app.selectRepository,
  });
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
  const selectCommit = (oid: Oid) => select({ kind: "commit", oid });
  // A stash clicked in another repository, selected once its snapshot loads.
  const [pendingStash, setPendingStash] = useState<{
    root: RepositoryRoot;
    oid: Oid;
  } | null>(null);
  const [sidebarJump, setSidebarJump] = useState<{
    root: RepositoryRoot;
    reference: FullRef;
  } | null>(null);
  const {
    jumped,
    jumpedUnloaded,
    hiddenJump,
    highlighted,
    ruledBranch,
    sidebarTag,
  } = jumpView({
    snapshot,
    jump,
    lastBranch,
    sidebarJump,
    selection: app.selection,
    loaded,
    visibleOids,
  });
  const checkedOut = useMemo(
    () =>
      new Map(
        snapshot?.worktrees.flatMap(({ head, name }) =>
          head.kind === "attached" ? [[head.reference, name] as const] : [],
        ),
      ),
    [snapshot],
  );
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
  const selectedStash =
    snapshot &&
    selected?.kind === "commit" &&
    snapshot.stashes.some((stash) => stash.oid === selected.oid)
      ? { root: snapshot.root, oid: selected.oid }
      : null;
  function cancelGridFocus() {
    gridFocus.current?.cancel.abort();
    gridFocus.current = null;
  }
  function showRepository(root: RepositoryRoot) {
    cancelGridFocus();
    setSidebarJump(null);
    settings.toRepository();
    expansion.setExpanded(root, true);
    if (root !== snapshot?.root) void app.selectRepository(root);
  }
  function jumpTo(root: RepositoryRoot, target: JumpTarget) {
    closeFile();
    const pending = root !== snapshot?.root;
    if (pending) showRepository(root);
    else if (visibleOids.has(target.oid))
      app.select({ kind: "commit", oid: target.oid });
    setSidebarJump({ root, reference: target.reference });
    setLastBranch((previous) => new Map(previous).set(root, target.reference));
    setJump((previous) => ({
      root,
      reference: target.reference,
      seq: (previous?.seq ?? 0) + 1,
      pending,
    }));
  }
  function select(next: Selection) {
    setSidebarJump(null);
    app.select(next);
  }
  function compareWith(next: Compare) {
    setSidebarJump(null);
    app.compareWith(next);
  }
  function endCompare() {
    setSidebarJump(null);
    app.endCompare();
  }
  function setRule(root: RepositoryRoot, next: VisibilityRule) {
    setSidebarJump(null);
    visibility.setRule(root, next);
  }
  function showStash(root: RepositoryRoot, stash: Stash) {
    closeFile();
    if (root === snapshot?.root) select({ kind: "commit", oid: stash.oid });
    else {
      showRepository(root);
      setPendingStash({ root, oid: stash.oid });
    }
  }
  function showInGraph(root: RepositoryRoot, target: JumpTarget) {
    setSidebarJump(null);
    if (isBranch(target)) visibility.reveal(root, target.reference);
    else visibility.setRule(root, NO_RULE);
    app.select({ kind: "commit", oid: target.oid });
    setJump((previous) => ({
      root,
      reference: target.reference,
      seq: (previous?.seq ?? 0) + 1,
      pending: false,
    }));
    historyRef.current?.focus();
  }
  const paletteActions = defineSlice({
    context: { picked: palette?.picked ?? null, typing: false },
    commands: {},
  });
  const navigationActions = defineSlice({
    context: {
      adding,
      selection: selected,
      compare: app.compare && { swappable: swapEnds(app.compare) !== null },
      sidebarBranch: ruledBranch && {
        name: ruledBranch.name,
        visibility: branchVisibility(rule, ruledBranch.reference),
        outOfView: hiddenJump !== null,
        local: ruledBranch.kind === "local",
        checkedOut: checkedOut.has(ruledBranch.reference),
      },
      sidebarTag: sidebarTag && { name: sidebarTag.name },
      rule: rule.kind,
    },
    commands: {
      addRepository: () => setAdding(true),
      openRepository: (root: RepositoryRoot) => {
        showRepository(root);
        if (root === snapshot?.root) return;
        const cancel = new AbortController();
        for (const type of ["pointerdown", "keydown"])
          window.addEventListener(type, cancelGridFocus, {
            capture: true,
            signal: cancel.signal,
          });
        gridFocus.current = { root, from: focusedElement(), cancel };
      },
      jumpToRef: (reference: FullRef) => {
        const target = snapshot && listedRef(snapshot, reference);
        if (snapshot && target) jumpTo(snapshot.root, target);
      },
      showStash: (stash: Stash) => {
        if (snapshot) showStash(snapshot.root, stash);
      },
      toggleHide: () => {
        if (snapshot && hiddenJump) showInGraph(snapshot.root, hiddenJump);
        else if (snapshot && ruledBranch)
          setRule(
            snapshot.root,
            toggleRule(rule, "hide", ruledBranch.reference),
          );
      },
      toggleSolo: () => {
        if (snapshot && ruledBranch)
          setRule(
            snapshot.root,
            toggleRule(rule, "solo", ruledBranch.reference),
          );
      },
      showAllBranches: () => {
        if (snapshot) setRule(snapshot.root, NO_RULE);
      },
      swapCompare: app.swapCompare,
      endCompare,
    },
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
  const { context, commands } = composeActions(
    settings.actions,
    layout.actions,
    paletteActions,
    history.actions,
    navigationActions,
    sync.actions,
    loop.actions,
    diff.actions,
    staging.actions,
    refWriteActions,
    merge.actions,
    undoActions,
  );
  const keys = useRef({ context, commands, palette: palette !== null });
  useLayoutEffect(() => {
    keys.current = { context, commands, palette: palette !== null };
  });
  const openPalette = useCallback(() => {
    paletteReturn.current = focusedElement();
    setPalette({ picked: historyRef.current?.picked() ?? null });
  }, [historyRef]);
  async function checkout(target: Start) {
    if (!snapshot) return;
    await writes.write(snapshot.root, checkoutWrite(target, snapshot.head));
    refocusIfLost();
  }
  async function stepHistory(step: Step) {
    const entry = nextEntry(writes.history, step);
    setSteppedRef(null);
    const outcome = await writes[step]();
    if (entry?.operation.kind === "checkout") refocusIfLost();
    const moved = entry && refStep(entry.operation, step);
    if (outcome.kind === "applied" && entry && moved)
      setSteppedRef({ root: entry.root, ...moved });
  }
  const jumpToStepped = useEffectEvent(jumpTo);
  const focusJumpedBranch = useEffectEvent(focusNamedBranch);
  useEffect(() => {
    if (steppedRef === null) return;
    const { root, left, gone } = steppedRef;
    const state = branchRefs.refs.get(root);
    const listed = (reference: FullRef) =>
      state?.kind === "ready" ? listedRef(state.refs, reference) : null;
    const target = left === null ? null : listed(left);
    if ((left !== null && target === null) || (gone && listed(gone))) return;
    setSteppedRef(null);
    if (shownElement(focusedElement())) return;
    if (target === null) return focusFallback();
    focusJumpedRow.current = true;
    jumpToStepped(root, target);
  }, [steppedRef, branchRefs.refs, focusFallback]);
  useEffect(() => {
    if (!focusJumpedRow.current) return;
    focusJumpedRow.current = false;
    focusJumpedBranch();
  }, [sidebarJump]);
  const closePalette = () => {
    flushSync(() => setPalette(null));
    const back = paletteReturn.current;
    if (shownElement(back)) back.focus({ preventScroll: true });
    if (!shownElement(back) || focusedElement() !== back) focusFallback();
  };
  const runItem = (item: PaletteItem) => {
    closePalette();
    item.run();
    refocusIfLost();
  };
  useEffect(() => {
    const pending = gridFocus.current;
    if (pending === null) return;
    if (snapshot?.root === pending.root) {
      const focused = focusedElement();
      if (
        palette === null &&
        (focused === pending.from ||
          focused === document.body ||
          focused === sidebarToggleRef.current ||
          focused?.closest(".history-table"))
      )
        historyRef.current?.focus();
    } else if (workspace.kind !== "error") return;
    cancelGridFocus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when the opened repository arrives or fails; the palette only gates the focus
  }, [snapshot?.root, workspace.kind, sidebarToggleRef, historyRef]);
  async function addRepository(path: string, signal: AbortSignal) {
    const added = await app.addRepository(path, signal);
    if (added.kind === "opened") {
      setSidebarJump(null);
      expansion.setExpanded(added.root, true);
    }
    return added.kind === "failed" ? added.problem : null;
  }
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

  const appSelect = app.select;
  useEffect(() => {
    if (jump === null) return;
    if (app.activeRoot !== jump.root) setJump(null);
    else if (jump.pending && settled?.root === jump.root) {
      const target = listedRef(settled, jump.reference);
      if (target && visibleOids.has(target.oid))
        appSelect({ kind: "commit", oid: target.oid });
      setJump({ ...jump, pending: false, seq: jump.seq + 1 });
    }
  }, [jump, settled, visibleOids, app.activeRoot, appSelect]);
  useEffect(() => {
    if (headOf === null || settled === null) return;
    if (settled.root === headOf && settled.head.kind !== "unborn")
      appSelect({ kind: "commit", oid: settled.head.oid });
    setHeadOf(null);
  }, [headOf, settled, appSelect]);
  useFocusRecovery(focus);
  useEffect(() => {
    if (pendingStash === null) return;
    if (app.activeRoot !== pendingStash.root) setPendingStash(null);
    else if (settled?.root === pendingStash.root) {
      if (settled.stashes.some((stash) => stash.oid === pendingStash.oid))
        appSelect({ kind: "commit", oid: pendingStash.oid });
      setPendingStash(null);
    }
  }, [pendingStash, settled, app.activeRoot, appSelect]);
  useEffect(() => {
    function keyboard(event: KeyboardEvent) {
      const { context, commands, palette } = keys.current;
      // A modal dialog owns Escape, even when its focused control was disabled and dropped focus.
      const dialogOpen = document.querySelector("dialog[open]") !== null;
      if (matchesShortcut(PALETTE_SHORTCUT, event, mac)) {
        event.preventDefault();
        const target =
          event.target instanceof HTMLElement ? event.target : null;
        if (!dialogOpen && !typingIn(target)) openPalette();
        return;
      }
      if (palette) {
        if (claimedWhilePaletteOpen(event, mac)) event.preventDefault();
        return;
      }
      const [origin] = event.composedPath();
      const typing = typingIn(origin instanceof HTMLElement ? origin : null);
      const action = shortcutAction(
        { ...context, dialogOpen, typing },
        event,
        mac,
      );
      if (action === null) return;
      event.preventDefault();
      action.run(commands);
    }
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, [openPalette]);
  usePrefetchLazyViews();

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
            highlighted={
              snapshot && jumped && highlighted
                ? { root: snapshot.root, reference: jumped.reference }
                : null
            }
            selectedStash={selectedStash}
            sync={overview.syncByRoot}
            onSelect={showRepository}
            onToggle={(root) =>
              expansion.setExpanded(root, !expansion.expanded.has(root))
            }
            onJump={jumpTo}
            onStash={showStash}
            ruleFor={visibility.ruleFor}
            onRule={setRule}
            onRemove={(root) => {
              app.removeRepository(root);
              expansion.setExpanded(root, false);
              visibility.setRule(root, NO_RULE);
              setLastBranch((previous) => {
                const next = new Map(previous);
                next.delete(root);
                return next;
              });
            }}
            onAdd={commands.addRepository}
            writable={
              snapshot && { root: snapshot.root, checkedOutIn: checkedOut }
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
                <button onClick={() => showInGraph(snapshot.root, hiddenJump)}>
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
                    revealSeq={jump?.seq ?? 0}
                    onSelect={select}
                    onCompare={compareWith}
                    onEndCompare={endCompare}
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
                        onSelectCommit={selectCommit}
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
                      onClick={() => setAdding(true)}
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
                    onClick={() => setAdding(true)}
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
                    onSelect={select}
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
      {palette && (
        <CommandPalette
          items={paletteItems(
            context,
            commands,
            mac,
            app.catalog.entries,
            snapshot,
          )}
          onClose={closePalette}
          onRun={runItem}
        />
      )}
      {editingMessage && headStatus && editableHead && (
        <EditMessageDialog
          status={headStatus}
          onSave={async (worktree, write) => {
            const outcome = await writes.write(worktree, write);
            if (outcome.kind === "applied") setHeadOf(worktree);
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
          onNamedBranch={(branch) => jumpTo(snapshot.root, branch)}
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
              setSteppedRef({
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
      {adding && (
        <AddRepositoryDialog
          onAdd={addRepository}
          onClose={() => setAdding(false)}
        />
      )}
    </div>
  );
}
