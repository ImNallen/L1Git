import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import {
  ArrowLeft,
  CloudDownload,
  EyeOff,
  FastForward,
  FolderGit2,
  Info,
  LoaderCircle,
  PanelLeft,
  PanelRight,
  Palette,
  Settings,
  Plus,
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
import type {
  ActionContext,
  Commands,
  PaletteItem,
  Screen,
  SettingsSection,
} from "./actions";
import { useAppearance } from "./appearance";
import { useBranchVisibility } from "./branchVisibility";
import type { ThemeSettings } from "./themes/catalog";
import { AppearanceSettings } from "./components/AppearanceSettings";
import { AddRepositoryDialog } from "./components/AddRepositoryDialog";
import { DiscardDialog } from "./components/DiscardDialog";
import { EditMessageDialog } from "./components/EditMessageDialog";
import { COMMIT_SUMMARY_ID } from "./components/CommitBox";
import { CommandPalette } from "./components/CommandPalette";
import { FetchSettings } from "./components/FetchSettings";
import { CommitInspector, InspectorFrame } from "./components/CommitInspector";
import { FileDiffPane, revisionOf } from "./components/FileDiffPane";
import type { DiffStyle, FileDiffHandle } from "./components/FileDiffPane";
import { History, HistoryPlaceholder } from "./components/History";
import type { HistoryHandle } from "./components/History";
import { PaneDivider } from "./components/PaneDivider";
import { RepositoryTree } from "./components/RepositoryTree";
import { UndoButtons, WriteNoticeRow } from "./components/UndoControls";
import { discardChoice, nextEntry, writeFor } from "./domain/operations";
import type { FileWrite, Write } from "./domain/operations";
import { swapEnds } from "./domain/comparison";
import { buildGraph } from "./domain/graph";
import { trunkTips } from "./domain/highlight";
import { readyAdvances } from "./domain/overview";
import { refLabels } from "./domain/refs";
import type {
  Branch,
  FullRef,
  Oid,
  RepositoryRefs,
  RepositoryRoot,
  Stash,
  Tag,
} from "./domain/repository";
import { sameSelection } from "./domain/selection";
import type { Compare } from "./domain/comparison";
import type { Selection } from "./domain/selection";
import {
  branchVisibility,
  NO_RULE,
  toggleRule,
  visibleCommits,
} from "./domain/visibility";
import type { VisibilityRule } from "./domain/visibility";
import { historyRows, listWrites, worktreeGroups } from "./domain/worktree";
import { useExpandedRepositories } from "./expandedRepositories";
import { useFetchSettings } from "./fetchSettings";
import { useHistoryColumns } from "./historyColumns";
import { repositoryWarnings, useOverview } from "./overview";
import { mac, macNative } from "./repositories";
import { useRepositoryRefs } from "./useRepositoryRefs";
import { useWorkspace } from "./useWorkspace";
import { useWrites } from "./useWrites";

/**
 * A branch jump. `pending` waits for the snapshot of `root` to load, then a
 * new `seq` reveals the branch after the history restores its scroll.
 */
type Jump = {
  root: RepositoryRoot;
  reference: FullRef;
  seq: number;
  pending: boolean;
};
function focusedElement(): Element | null {
  let focused = document.activeElement;
  while (focused?.shadowRoot?.activeElement)
    focused = focused.shadowRoot.activeElement;
  return focused;
}

function shownElement(element: Element | null): element is HTMLElement {
  return (
    element instanceof HTMLElement &&
    element !== document.body &&
    element.isConnected &&
    element.getClientRects().length > 0
  );
}

type JumpTarget = Branch | Tag;

const isBranch = (target: JumpTarget): target is Branch => "kind" in target;

function listedRef(
  refs: Pick<RepositoryRefs, "branches" | "tags">,
  reference: FullRef,
): JumpTarget | null {
  return (
    refs.branches.find((branch) => branch.reference === reference) ??
    refs.tags.find((tag) => tag.reference === reference) ??
    null
  );
}

const settingsSections = [
  { section: "appearance", label: "Appearance", Icon: Palette },
  { section: "fetching", label: "Fetching", Icon: CloudDownload },
] as const;

export function App({ initialTheme }: { initialTheme: ThemeSettings }) {
  const appearance = useAppearance(initialTheme);
  const app = useWorkspace();
  const [screen, setScreen] = useState<Screen>("repository");
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection>("appearance");
  const fetchSettings = useFetchSettings();
  const { view: overview, store: overviewStore } = useOverview(
    app.catalog.entries.map((entry) => entry.root),
    fetchSettings.intervalMinutes,
  );
  const [adding, setAdding] = useState(false);
  const [editingMessage, setEditingMessage] = useState(false);
  const [headOf, setHeadOf] = useState<RepositoryRoot | null>(null);
  const [lostFocusChecks, checkLostFocus] = useState(0);
  const [discarding, setDiscarding] = useState<{
    root: RepositoryRoot;
    write: Write;
    paths: string[];
    skipped: number;
    returnFocus?: () => void;
  } | null>(null);
  const [palette, setPalette] = useState<{ picked: Oid | null } | null>(null);
  const paletteReturn = useRef<Element | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(
    () => window.innerWidth >= 1100,
  );
  const [sidebarWidth, setSidebarWidth] = useState(260);
  const [inspectorWidth, setInspectorWidth] = useState(320);
  const [diffStyle, setDiffStyle] = useState<DiffStyle>("unified");
  const [jump, setJump] = useState<Jump | null>(null);
  // The branch or tag last selected in each repository, so it stays highlighted after a round trip.
  const [lastBranch, setLastBranch] = useState<
    ReadonlyMap<RepositoryRoot, FullRef>
  >(new Map());
  const sidebarToggleRef = useRef<HTMLButtonElement>(null);
  const inspectorToggleRef = useRef<HTMLButtonElement>(null);
  const settingsRef = useRef<HTMLButtonElement>(null);
  const historyRef = useRef<HistoryHandle>(null);
  const fileDiffRef = useRef<FileDiffHandle>(null);
  const gridFocus = useRef<{
    root: RepositoryRoot;
    from: Element | null;
    cancel: AbortController;
  } | null>(null);
  const leaveSettings = useCallback(() => {
    flushSync(() => setScreen("repository"));
    (sidebarOpen ? settingsRef : sidebarToggleRef).current?.focus();
  }, [sidebarOpen]);
  const { workspace, current, fileDiff, closeFile } = app;
  const fileOpen = fileDiff.kind !== "closed";
  const busy = workspace.kind === "loading" || workspace.kind === "opening";
  const snapshot = current?.snapshot ?? null;
  const opening = workspace.kind === "opening" ? workspace : null;
  const shown = snapshot
    ? { root: snapshot.root, name: snapshot.name }
    : opening && { root: opening.path, name: opening.name };
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
  const rule = snapshot ? visibility.ruleFor(snapshot.root) : NO_RULE;
  const visible = useMemo(
    () => (snapshot ? visibleCommits(snapshot.commits, snapshot, rule) : []),
    [snapshot, rule],
  );
  const rows = useMemo(
    () =>
      snapshot ? historyRows(visible, snapshot.worktrees, app.changes) : [],
    [snapshot, visible, app.changes],
  );
  const selected = app.selection;
  const listedWorktree =
    selected?.kind === "worktree"
      ? snapshot?.worktrees.find((worktree) => worktree.root === selected.root)
      : undefined;
  const selectedWorktree = listedWorktree
    ? {
        worktree: listedWorktree,
        changes: app.changes.get(listedWorktree.root),
      }
    : null;
  const writes = useWrites(snapshot?.root ?? null, {
    worktree: app.rereadWorktree,
    repository: app.rereadOpenRepository,
    refs: (worktree, repository) => {
      const state =
        overview.roots.get(worktree) ?? overview.roots.get(repository);
      if (state?.kind === "open")
        void overviewStore.refreshLocal(state.commonDir);
      return app.rereadOpenRepository(repository);
    },
  });
  function writeFiles(
    root: RepositoryRoot,
    kind: FileWrite,
    paths: readonly string[],
  ) {
    const changes = app.changes.get(root);
    const write =
      changes?.kind === "ready" ? writeFor(kind, changes.status, paths) : null;
    return write === null ? Promise.resolve(false) : writes.write(root, write);
  }
  function askDiscard(
    root: RepositoryRoot,
    paths: readonly string[],
    returnFocus?: () => void,
  ) {
    const changes = app.changes.get(root);
    if (changes?.kind !== "ready") return;
    const choice = discardChoice(changes.status, paths);
    const write = writeFor("discard", changes.status, choice.paths);
    if (write !== null) setDiscarding({ root, write, ...choice, returnFocus });
  }
  const rootChanges = snapshot ? app.changes.get(snapshot.root) : undefined;
  const headStatus = rootChanges?.kind === "ready" ? rootChanges.status : null;
  const editableHead =
    headStatus?.head.kind === "unborn" ? null : (headStatus?.head.oid ?? null);
  const selectedChanges =
    app.compare === null ? selectedWorktree?.changes : undefined;
  const selectedLists = useMemo(
    () =>
      selectedChanges?.kind === "ready"
        ? new Map(
            worktreeGroups(selectedChanges.status.entries).map((group) => [
              group.side,
              group.files.map((file) => file.path),
            ]),
          )
        : null,
    [selectedChanges],
  );
  function writeList(side: "unstaged" | "staged") {
    const paths = selectedLists?.get(side);
    if (selectedWorktree && paths)
      void writeFiles(
        selectedWorktree.worktree.root,
        listWrites[side].kind,
        paths,
      );
  }
  const loaded = useMemo(
    () => new Set(snapshot?.commits.map((commit) => commit.oid)),
    [snapshot],
  );
  const visibleOids = useMemo(
    () =>
      visible === snapshot?.commits
        ? loaded
        : new Set(visible.map((commit) => commit.oid)),
    [visible, snapshot, loaded],
  );
  const graph = useMemo(
    () =>
      buildGraph(
        rows,
        visible === snapshot?.commits
          ? snapshot.squashes
          : snapshot?.squashes.filter(
              (squash) =>
                visibleOids.has(squash.commit) && visibleOids.has(squash.tip),
            ),
      ),
    [rows, visible, visibleOids, snapshot],
  );
  const labels = useMemo(
    () => (snapshot ? refLabels(snapshot) : null),
    [snapshot],
  );
  const selectedOid = selected?.kind === "commit" ? selected.oid : null;
  const selectedRefs =
    selectedOid === null ? [] : (labels?.get(selectedOid) ?? []);
  const selectedLane =
    selectedOid === null ? null : (graph.rows.get(selectedOid)?.lane ?? null);
  const shows = useCallback((oid: Oid) => visibleOids.has(oid), [visibleOids]);
  const selectCommit = useCallback(
    (oid: Oid) => select({ kind: "commit", oid }),
    [select],
  );
  // A stash clicked in another repository, selected once its snapshot loads.
  const [pendingStash, setPendingStash] = useState<{
    root: RepositoryRoot;
    oid: Oid;
  } | null>(null);
  const [sidebarJump, setSidebarJump] = useState<{
    root: RepositoryRoot;
    reference: FullRef;
  } | null>(null);
  const inspectorVisible = Boolean(shown && inspectorOpen);
  const activePath =
    shown?.root ?? (workspace.kind === "error" ? workspace.path : null);
  const openRoot = shown?.root ?? null;
  const openRootState = openRoot === null ? null : overview.roots.get(openRoot);
  const openRepository =
    openRootState?.kind === "open"
      ? (overview.repositories.find(
          (repository) => repository.commonDir === openRootState.commonDir,
        ) ?? null)
      : null;
  const openFetching = openRepository?.activity.kind === "fetching";
  const openReady = openRepository
    ? readyAdvances(openRepository.overview).length
    : 0;
  const statuses = openRepository?.overview.branches;
  const trunk = useMemo(
    () => (snapshot ? trunkTips(snapshot.branches, statuses ?? []) : []),
    [snapshot, statuses],
  );
  const jumpedReference =
    snapshot && !(jump?.pending && jump.root === snapshot.root)
      ? lastBranch.get(snapshot.root)
      : undefined;
  const jumped =
    snapshot && jumpedReference ? listedRef(snapshot, jumpedReference) : null;
  const jumpedUnloaded = jumped !== null && !loaded.has(jumped.oid);
  const hiddenJump =
    jumped !== null &&
    sidebarJump?.root === snapshot?.root &&
    sidebarJump?.reference === jumped.reference &&
    !jumpedUnloaded &&
    !visibleOids.has(jumped.oid)
      ? jumped
      : null;
  const highlighted =
    jumped !== null &&
    sameSelection(app.selection, { kind: "commit", oid: jumped.oid });
  const ruledBranch =
    jumped && isBranch(jumped) && (highlighted || hiddenJump) ? jumped : null;
  const selectedStash =
    snapshot &&
    selected?.kind === "commit" &&
    snapshot.stashes.some((stash) => stash.oid === selected.oid)
      ? { root: snapshot.root, oid: selected.oid }
      : null;
  const rereadChanges = () => {
    app.refreshChanges();
    writes.rereadHistory();
  };
  const rereadAll = () => {
    rereadChanges();
    return app.refresh();
  };
  const refreshRef = useRef(rereadAll);
  const reloadRefsRef = useRef(branchRefs.reload);
  useEffect(() => {
    refreshRef.current = rereadAll;
    reloadRefsRef.current = branchRefs.reload;
  });
  // Commits and branches made outside L1 Git show up when its window regains focus.
  useEffect(() => {
    let last = 0;
    const reread = () => {
      if (document.hidden || performance.now() - last < 1000) return;
      last = performance.now();
      void refreshRef.current();
      reloadRefsRef.current();
    };
    window.addEventListener("focus", reread);
    document.addEventListener("visibilitychange", reread);
    return () => {
      window.removeEventListener("focus", reread);
      document.removeEventListener("visibilitychange", reread);
    };
  }, []);
  useEffect(
    () =>
      overviewStore.onRefsChanged((roots) => {
        if (roots.some((root) => root === app.activeRoot))
          void refreshRef.current();
      }),
    [overviewStore, app.activeRoot],
  );
  function cancelGridFocus() {
    gridFocus.current?.cancel.abort();
    gridFocus.current = null;
  }
  function showRepository(root: RepositoryRoot) {
    cancelGridFocus();
    setSidebarJump(null);
    setScreen("repository");
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
  const commands: Commands = {
    addRepository: () => setAdding(true),
    openSettings: (section) => {
      if (section) setSettingsSection(section);
      setScreen("settings");
    },
    leaveSettings,
    toggleSidebar: () => setSidebarOpen((open) => !open),
    toggleInspector: () => setInspectorOpen((open) => !open),
    fetch: () => {
      if (openRepository) void overviewStore.fetch(openRepository.commonDir);
    },
    fastForward: () => {
      if (openRepository)
        void overviewStore.updateAll(openRepository.commonDir);
    },
    search: () => historyRef.current?.openSearch(),
    closeFile,
    showFile: (view) => fileDiffRef.current?.show(view),
    compareWithWorkingCopy: () => {
      if (selected?.kind === "commit")
        historyRef.current?.compareWithWorkingCopy(selected.oid);
    },
    compareWithPick: () => {
      if (selected?.kind === "commit")
        historyRef.current?.compareWithPick(selected.oid);
    },
    pick: () => {
      if (selected?.kind === "commit") historyRef.current?.pick(selected.oid);
    },
    clearPick: () => historyRef.current?.pick(null),
    swapCompare: app.swapCompare,
    endCompare,
    toggleHide: () => {
      if (snapshot && hiddenJump) showInGraph(snapshot.root, hiddenJump);
      else if (snapshot && ruledBranch)
        setRule(snapshot.root, toggleRule(rule, "hide", ruledBranch.reference));
    },
    toggleSolo: () => {
      if (snapshot && ruledBranch)
        setRule(snapshot.root, toggleRule(rule, "solo", ruledBranch.reference));
    },
    showAllBranches: () => {
      if (snapshot) setRule(snapshot.root, NO_RULE);
    },
    openRepository: (root) => {
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
    jumpToRef: (reference) => {
      const target = snapshot && listedRef(snapshot, reference);
      if (snapshot && target) jumpTo(snapshot.root, target);
    },
    showStash: (stash) => {
      if (snapshot) showStash(snapshot.root, stash);
    },
    stageAll: () => writeList("unstaged"),
    unstageAll: () => writeList("staged"),
    discardAll: () => {
      const paths = selectedLists?.get("unstaged");
      if (selectedWorktree && paths)
        askDiscard(selectedWorktree.worktree.root, paths);
    },
    focusCommit: () => {
      flushSync(() => setInspectorOpen(true));
      document.getElementById(COMMIT_SUMMARY_ID)?.focus();
    },
    undo: () => void writes.undo(),
    redo: () => void writes.redo(),
  };
  const context: ActionContext = {
    screen,
    section: settingsSection,
    dialogOpen: false,
    adding,
    searchable: snapshot !== null,
    inspectable: shown !== null,
    repository: openRepository && {
      fetching: openFetching,
      idle: openRepository.activity.kind === "idle",
      ready: openReady,
    },
    file:
      fileDiff.kind === "closed"
        ? null
        : { hasCommit: revisionOf(fileDiff) !== null },
    selection: selected,
    picked: palette?.picked ?? null,
    compare: app.compare && { swappable: swapEnds(app.compare) !== null },
    sidebarBranch: ruledBranch && {
      name: ruledBranch.name,
      visibility: branchVisibility(rule, ruledBranch.reference),
      outOfView: hiddenJump !== null,
    },
    rule: rule.kind,
    worktree: selectedLists && {
      unstaged: selectedLists.get("unstaged")?.length ?? 0,
      staged: selectedLists.get("staged")?.length ?? 0,
      discardable:
        selectedChanges?.kind === "ready"
          ? discardChoice(
              selectedChanges.status,
              selectedLists.get("unstaged") ?? [],
            ).paths.length
          : 0,
    },
    history: {
      undo: nextEntry(writes.history, "undo")?.label ?? null,
      redo: nextEntry(writes.history, "redo")?.label ?? null,
    },
    writing: writes.running !== null,
    typing: false,
  };
  const keys = useRef({ context, commands, palette: palette !== null });
  useLayoutEffect(() => {
    keys.current = { context, commands, palette: palette !== null };
  });
  const openPalette = useCallback(() => {
    paletteReturn.current = focusedElement();
    setPalette({ picked: historyRef.current?.picked() ?? null });
  }, []);
  const focusFallback = () => {
    for (const focus of [
      () => historyRef.current?.focus(),
      () => fileDiffRef.current?.focus(),
      () => sidebarToggleRef.current?.focus(),
    ]) {
      focus();
      if (shownElement(focusedElement())) return;
    }
  };
  const closePalette = () => {
    flushSync(() => setPalette(null));
    const back = paletteReturn.current;
    if (shownElement(back)) back.focus({ preventScroll: true });
    if (!shownElement(back) || focusedElement() !== back) focusFallback();
  };
  const runItem = (item: PaletteItem) => {
    closePalette();
    item.run();
    requestAnimationFrame(() => {
      if (!shownElement(focusedElement())) focusFallback();
    });
  };
  useEffect(() => {
    const pending = gridFocus.current;
    if (pending === null) return;
    if (snapshot?.root === pending.root) {
      const focused = focusedElement();
      if (
        !keys.current.palette &&
        (focused === pending.from ||
          focused === document.body ||
          focused === sidebarToggleRef.current ||
          focused?.closest(".history-table"))
      )
        historyRef.current?.focus();
    } else if (workspace.kind !== "error") return;
    cancelGridFocus();
  }, [snapshot?.root, workspace.kind]);
  async function addRepository(path: string, signal: AbortSignal) {
    const added = await app.addRepository(path, signal);
    if (added.kind === "opened") {
      setSidebarJump(null);
      expansion.setExpanded(added.root, true);
    }
    return added.kind === "failed" ? added.problem : null;
  }
  const sidebarToggle = (
    <button
      ref={sidebarToggleRef}
      className={`icon-button sidebar-toggle ${sidebarOpen ? "toggled" : ""}`}
      aria-label="Toggle sidebar"
      title="Toggle sidebar"
      aria-pressed={sidebarOpen}
      onClick={() => {
        flushSync(commands.toggleSidebar);
        sidebarToggleRef.current?.focus();
      }}
    >
      <PanelLeft size={16} />
    </button>
  );
  const inspectorToggle = (
    <button
      ref={inspectorToggleRef}
      className={`icon-button ${inspectorVisible ? "toggled" : ""}`}
      disabled={!shown}
      aria-label="Toggle commit inspector"
      title="Toggle commit inspector"
      aria-pressed={inspectorVisible}
      onClick={() => {
        flushSync(commands.toggleInspector);
        inspectorToggleRef.current?.focus();
      }}
    >
      <PanelRight size={16} />
    </button>
  );

  // A cached snapshot can predate the branch, tag, or stash clicked in the
  // sidebar, so pending selections wait for the reread to finish.
  const reread = workspace.kind === "ready" ? workspace.snapshot : null;
  useEffect(() => {
    if (jump === null) return;
    if (app.activeRoot !== jump.root) setJump(null);
    else if (jump.pending && reread?.root === jump.root) {
      const target = listedRef(reread, jump.reference);
      if (target && visibleOids.has(target.oid))
        app.select({ kind: "commit", oid: target.oid });
      setJump({ ...jump, pending: false, seq: jump.seq + 1 });
    }
  }, [jump, reread, visibleOids, app.activeRoot, app.select]);
  useEffect(() => {
    if (headOf === null || reread === null) return;
    if (reread.root === headOf && reread.head.kind !== "unborn")
      app.select({ kind: "commit", oid: reread.head.oid });
    setHeadOf(null);
  }, [headOf, reread, app.select]);
  useEffect(() => {
    if (lostFocusChecks > 0 && !shownElement(focusedElement())) focusFallback();
  }, [lostFocusChecks]);
  useEffect(() => {
    if (pendingStash === null) return;
    if (app.activeRoot !== pendingStash.root) setPendingStash(null);
    else if (reread?.root === pendingStash.root) {
      if (reread.stashes.some((stash) => stash.oid === pendingStash.oid))
        app.select({ kind: "commit", oid: pendingStash.oid });
      setPendingStash(null);
    }
  }, [pendingStash, reread, app.activeRoot, app.select]);
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
  useEffect(() => {
    const media = window.matchMedia("(max-width: 1099px)");
    const narrow = () => {
      if (media.matches) setInspectorOpen(false);
    };
    media.addEventListener("change", narrow);
    return () => media.removeEventListener("change", narrow);
  }, []);

  return (
    <div
      className={`app ${macNative ? "native-mac" : ""} ${sidebarOpen ? "" : "sidebar-hidden"}`}
    >
      <aside
        hidden={!sidebarOpen}
        className="sidebar"
        style={{ width: sidebarWidth }}
        aria-label={
          screen === "settings" ? "Settings sidebar" : "Repository sidebar"
        }
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
        <div className="repository-navigation" hidden={screen === "settings"}>
          <RepositoryTree
            entries={app.catalog.entries}
            expanded={expansion.expanded}
            refs={branchRefs.refs}
            activePath={screen === "repository" ? activePath : null}
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
          />
        </div>
        {screen === "settings" && (
          <nav className="settings-navigation" aria-label="Settings">
            {settingsSections.map(({ section, label, Icon }) => (
              <button
                key={section}
                className="settings-nav-item"
                aria-current={settingsSection === section ? "page" : undefined}
                onClick={() => setSettingsSection(section)}
              >
                <Icon size={16} />
                {label}
              </button>
            ))}
          </nav>
        )}
        <footer className="sidebar-bottom">
          {screen === "settings" ? (
            <button className="settings-back" onClick={leaveSettings}>
              <ArrowLeft size={15} /> Back
            </button>
          ) : (
            <button
              ref={settingsRef}
              className="icon-button"
              aria-label="Settings"
              title="Settings"
              onClick={() => commands.openSettings()}
            >
              <Settings size={16} />
            </button>
          )}
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
        <div className="repository-workspace" hidden={screen !== "repository"}>
          <div className="repository-content">
            <header className="toolbar" data-tauri-drag-region>
              {screen === "repository" && !sidebarOpen && sidebarToggle}
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
                {openRepository && (
                  <button
                    className="button secondary"
                    disabled={openFetching}
                    onClick={commands.fetch}
                    title="Download new commits from this repository's remotes."
                  >
                    {openFetching ? (
                      <LoaderCircle size={14} className="spin" />
                    ) : (
                      <CloudDownload size={14} />
                    )}
                    <span>Fetch</span>
                  </button>
                )}
                {openRepository && openReady > 0 && (
                  <button
                    className="button secondary"
                    disabled={openRepository.activity.kind !== "idle"}
                    onClick={commands.fastForward}
                    title={`Fast-forward ${openReady === 1 ? "1 branch that is" : `${openReady} branches that are`} behind and clean. Never merges or rebases.`}
                  >
                    {openRepository.activity.kind === "updating" ? (
                      <LoaderCircle size={14} className="spin" />
                    ) : (
                      <FastForward size={14} />
                    )}
                    <span>Fast-forward ({openReady})</span>
                  </button>
                )}
                {!inspectorVisible && inspectorToggle}
              </div>
            </header>
            <WriteNoticeRow writes={writes} />
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
                <button onClick={() => void rereadAll()}>Try again</button>
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
              {snapshot ? (
                <>
                  <History
                    ref={historyRef}
                    snapshot={snapshot}
                    visibleCommits={visible}
                    visibleOids={visibleOids}
                    rows={rows}
                    graph={graph}
                    rule={rule}
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
                    trunk={trunk}
                    visibleColumns={historyColumns.visible}
                    onToggleColumn={historyColumns.toggle}
                    editableHead={editableHead}
                    onEditMessage={() => setEditingMessage(true)}
                  />
                  {fileDiff.kind !== "closed" && (
                    <FileDiffPane
                      ref={fileDiffRef}
                      state={fileDiff}
                      diffStyle={diffStyle}
                      theme={appearance.variant.appearance}
                      painted={
                        Object.keys(appearance.variant.palette).length > 0
                      }
                      onDiffStyle={setDiffStyle}
                      onBack={closeFile}
                      onRetry={() => app.openFile(fileDiff.path, fileDiff.side)}
                      onRefresh={() => {
                        rereadChanges();
                        app.openFile(fileDiff.path, fileDiff.side);
                      }}
                      selectable={shows}
                      onSelectCommit={selectCommit}
                    />
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
                    refs={selectedRefs}
                    lane={selectedLane}
                    onSelect={select}
                    onSwap={app.swapCompare}
                    selectedFile={fileOpen ? fileDiff : null}
                    onSelectFile={app.openFile}
                    toggleButton={inspectorToggle}
                    onRetry={app.retryDetail}
                    worktree={selectedWorktree}
                    onRefreshChanges={rereadChanges}
                    writes={{
                      busy: writes.running !== null,
                      write: writeFiles,
                      commit: async (worktree, write) => {
                        const outcome = await writes.write(worktree, write);
                        checkLostFocus((count) => count + 1);
                        return outcome;
                      },
                      confirmDiscard: askDiscard,
                    }}
                  />
                ) : (
                  <InspectorFrame toggleButton={inspectorToggle} />
                )}
              </div>
            </>
          )}
        </div>
        {screen === "settings" && (
          <>
            <header className="toolbar settings-toolbar" data-tauri-drag-region>
              {!sidebarOpen && sidebarToggle}
              <nav
                className="breadcrumb"
                aria-label="Breadcrumb"
                data-tauri-drag-region
              >
                <span className="muted" data-tauri-drag-region>
                  Settings
                </span>
                <span className="breadcrumb-slash" data-tauri-drag-region>
                  /
                </span>
                <span aria-current="page" data-tauri-drag-region>
                  {
                    settingsSections.find(
                      ({ section }) => section === settingsSection,
                    )?.label
                  }
                </span>
              </nav>
            </header>
            {settingsSection === "appearance" ? (
              <AppearanceSettings appearance={appearance} />
            ) : (
              <FetchSettings
                intervalMinutes={fetchSettings.intervalMinutes}
                onIntervalChange={fetchSettings.setIntervalMinutes}
                persistenceError={fetchSettings.persistenceError}
              />
            )}
          </>
        )}
      </main>
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
      {discarding && (
        <DiscardDialog
          paths={discarding.paths}
          skipped={discarding.skipped}
          onDiscard={() => void writes.write(discarding.root, discarding.write)}
          onClose={() => {
            setDiscarding(null);
            discarding.returnFocus?.();
          }}
        />
      )}
      {adding && (
        <AddRepositoryDialog
          onAdd={addRepository}
          onClose={() => setAdding(false)}
        />
      )}
    </div>
  );
}
