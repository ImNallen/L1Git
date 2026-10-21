import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { useAppearance } from "./appearance";
import { useBranchVisibility } from "./branchVisibility";
import type { ThemeSettings } from "./themes/catalog";
import { AppearanceSettings } from "./components/AppearanceSettings";
import { AddRepositoryDialog } from "./components/AddRepositoryDialog";
import { FetchSettings } from "./components/FetchSettings";
import { CommitInspector, InspectorFrame } from "./components/CommitInspector";
import { FileDiffPane } from "./components/FileDiffPane";
import type { DiffStyle } from "./components/FileDiffPane";
import { History, HistoryPlaceholder } from "./components/History";
import type { HistoryHandle } from "./components/History";
import { PaneDivider } from "./components/PaneDivider";
import { RepositoryTree } from "./components/RepositoryTree";
import { trunkTips } from "./domain/highlight";
import { readyAdvances } from "./domain/overview";
import type { Branch, FullRef, Oid, RepositoryRoot } from "./domain/repository";
import { NO_RULE, revealBranch, visibleCommits } from "./domain/visibility";
import { useExpandedRepositories } from "./expandedRepositories";
import { useFetchSettings } from "./fetchSettings";
import { useHistoryColumns } from "./historyColumns";
import { repositoryWarnings, useOverview } from "./overview";
import { mac, macNative } from "./repositories";
import { useRepositoryRefs } from "./useRepositoryRefs";
import { useWorkspace } from "./useWorkspace";

type AppScreen = "repository" | "settings";
type SettingsSection = "appearance" | "fetching";
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
const settingsSections = [
  { section: "appearance", label: "Appearance", Icon: Palette },
  { section: "fetching", label: "Fetching", Icon: CloudDownload },
] as const;

export function App({ initialTheme }: { initialTheme: ThemeSettings }) {
  const appearance = useAppearance(initialTheme);
  const app = useWorkspace();
  const [screen, setScreen] = useState<AppScreen>("repository");
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection>("appearance");
  const fetchSettings = useFetchSettings();
  const { view: overview, store: overviewStore } = useOverview(
    app.catalog.entries.map((entry) => entry.root),
    fetchSettings.intervalMinutes,
  );
  const [adding, setAdding] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(
    () => window.innerWidth >= 1100,
  );
  const [sidebarWidth, setSidebarWidth] = useState(260);
  const [inspectorWidth, setInspectorWidth] = useState(320);
  const [diffStyle, setDiffStyle] = useState<DiffStyle>("unified");
  const [jump, setJump] = useState<Jump | null>(null);
  // The branch last selected in each repository, so it stays highlighted after a round trip.
  const [lastBranch, setLastBranch] = useState<
    ReadonlyMap<RepositoryRoot, FullRef>
  >(new Map());
  const sidebarToggleRef = useRef<HTMLButtonElement>(null);
  const inspectorToggleRef = useRef<HTMLButtonElement>(null);
  const settingsRef = useRef<HTMLButtonElement>(null);
  const historyRef = useRef<HistoryHandle>(null);
  const leaveSettings = useCallback(() => {
    flushSync(() => setScreen("repository"));
    (sidebarOpen ? settingsRef : sidebarToggleRef).current?.focus();
  }, [sidebarOpen]);
  const { workspace, current, fileDiff, closeFile, setSelectedOid } = app;
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
  const rule = snapshot ? visibility.ruleFor(snapshot.root) : NO_RULE;
  const visible = useMemo(
    () => (snapshot ? visibleCommits(snapshot.commits, snapshot, rule) : []),
    [snapshot, rule],
  );
  const shows = (oid: Oid) => visible.some((commit) => commit.oid === oid);
  const branchRefs = useRepositoryRefs(
    expansion.expanded,
    snapshot,
    overviewStore,
  );
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
    snapshot && jumpedReference
      ? (snapshot.branches.find(
          (branch) => branch.reference === jumpedReference,
        ) ?? null)
      : null;
  const jumpedUnloaded =
    jumped !== null &&
    snapshot !== null &&
    !snapshot.commits.some((commit) => commit.oid === jumped.oid);
  const jumpedHidden = jumped !== null && !jumpedUnloaded && !shows(jumped.oid);
  const refreshRef = useRef(app.refresh);
  const reloadRefsRef = useRef(branchRefs.reload);
  useEffect(() => {
    refreshRef.current = app.refresh;
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
  function showRepository(root: RepositoryRoot) {
    setScreen("repository");
    expansion.setExpanded(root, true);
    if (root !== snapshot?.root) void app.selectRepository(root);
  }
  function jumpTo(root: RepositoryRoot, branch: Branch) {
    closeFile();
    const pending = root !== snapshot?.root;
    if (pending) showRepository(root);
    else if (shows(branch.oid)) setSelectedOid(branch.oid);
    setLastBranch((previous) => new Map(previous).set(root, branch.reference));
    setJump((previous) => ({
      root,
      reference: branch.reference,
      seq: (previous?.seq ?? 0) + 1,
      pending,
    }));
  }
  function showBranch(root: RepositoryRoot, branch: Branch) {
    visibility.setRule(
      root,
      revealBranch(visibility.ruleFor(root), branch.reference),
    );
    setSelectedOid(branch.oid);
    setJump((previous) => ({
      root,
      reference: branch.reference,
      seq: (previous?.seq ?? 0) + 1,
      pending: false,
    }));
  }
  async function addRepository(path: string, signal: AbortSignal) {
    const added = await app.addRepository(path, signal);
    if (added.kind === "opened") expansion.setExpanded(added.root, true);
    return added.kind === "failed" ? added.problem : null;
  }
  const sidebarToggle = (
    <button
      ref={sidebarToggleRef}
      className={`icon-button ${sidebarOpen ? "toggled" : ""}`}
      aria-label="Toggle sidebar"
      title="Toggle sidebar"
      aria-pressed={sidebarOpen}
      onClick={() => {
        flushSync(() => setSidebarOpen((open) => !open));
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
        flushSync(() => setInspectorOpen((open) => !open));
        inspectorToggleRef.current?.focus();
      }}
    >
      <PanelRight size={16} />
    </button>
  );

  useEffect(() => {
    if (jump === null) return;
    if (app.activeRoot !== jump.root) setJump(null);
    else if (jump.pending && snapshot?.root === jump.root) {
      const branch = snapshot.branches.find(
        (branch) => branch.reference === jump.reference,
      );
      if (branch && visible.some((commit) => commit.oid === branch.oid))
        setSelectedOid(branch.oid);
      setJump({ ...jump, pending: false, seq: jump.seq + 1 });
    }
  }, [jump, snapshot, visible, app.activeRoot, setSelectedOid]);
  useEffect(() => {
    function keyboard(event: KeyboardEvent) {
      if (screen === "settings") {
        // A modal dialog owns Escape, even when its focused control was disabled and dropped focus.
        if (event.key === "Escape" && !document.querySelector("dialog[open]")) {
          event.preventDefault();
          leaveSettings();
        }
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "o") {
        event.preventDefault();
        setAdding(true);
      }
      if (screen !== "repository" || adding) return;
      if (fileOpen && event.key === "Escape") closeFile();
      if (
        !fileOpen &&
        historyRef.current &&
        (mac
          ? event.metaKey && !event.ctrlKey
          : event.ctrlKey && !event.metaKey) &&
        !event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === "f"
      ) {
        event.preventDefault();
        historyRef.current.openSearch();
      }
    }
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, [adding, fileOpen, closeFile, screen, leaveSettings]);
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
              snapshot && jumped !== null && jumped.oid === app.selectedOid
                ? { root: snapshot.root, reference: jumped.reference }
                : null
            }
            sync={overview.syncByRoot}
            onSelect={showRepository}
            onToggle={(root) =>
              expansion.setExpanded(root, !expansion.expanded.has(root))
            }
            onJump={jumpTo}
            ruleFor={visibility.ruleFor}
            onRule={visibility.setRule}
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
            onAdd={() => setAdding(true)}
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
              onClick={() => setScreen("settings")}
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
                {openRepository && (
                  <button
                    className="button secondary"
                    disabled={openFetching}
                    onClick={() =>
                      void overviewStore.fetch(openRepository.commonDir)
                    }
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
                    onClick={() =>
                      void overviewStore.updateAll(openRepository.commonDir)
                    }
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
                <button onClick={() => void app.refresh()}>Try again</button>
              </div>
            )}
            {openRepository &&
              repositoryWarnings(openRepository).map((warning) => (
                <div className="notice error-notice" role="alert" key={warning}>
                  <TriangleAlert size={14} />
                  <span>{warning}</span>
                </div>
              ))}
            {jumped && jumpedHidden && snapshot && (
              <div className="notice info-notice" role="status">
                <EyeOff size={14} />
                <span>
                  {jumped.name}{" "}
                  {rule.kind === "solo"
                    ? "is outside the soloed branches."
                    : "is hidden in the graph."}
                </span>
                <button onClick={() => showBranch(snapshot.root, jumped)}>
                  Show {jumped.name}
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
                    rule={rule}
                    selectedOid={app.selectedOid}
                    revealSeq={jump?.seq ?? 0}
                    onSelect={app.setSelectedOid}
                    onOpenFirstFile={app.openFirstFile}
                    onCancelOpen={app.cancelOpenFirstFile}
                    scrollTopOf={app.scrollTopOf}
                    onScroll={app.rememberScroll}
                    busy={busy}
                    hidden={fileOpen}
                    trunk={trunk}
                    visibleColumns={historyColumns.visible}
                    onToggleColumn={historyColumns.toggle}
                  />
                  {fileDiff.kind !== "closed" && (
                    <FileDiffPane
                      state={fileDiff}
                      diffStyle={diffStyle}
                      theme={appearance.variant.appearance}
                      painted={
                        Object.keys(appearance.variant.palette).length > 0
                      }
                      onDiffStyle={setDiffStyle}
                      onBack={closeFile}
                      onRetry={() => app.openFile(fileDiff.path)}
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
                    selectedOid={app.selectedOid}
                    snapshot={snapshot}
                    onSelect={app.setSelectedOid}
                    selectedFile={fileOpen ? fileDiff.path : null}
                    onSelectFile={app.openFile}
                    toggleButton={inspectorToggle}
                    onRetry={app.retryDetail}
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
      {adding && (
        <AddRepositoryDialog
          onAdd={addRepository}
          onClose={() => setAdding(false)}
        />
      )}
    </div>
  );
}
