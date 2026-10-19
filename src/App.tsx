import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  ArrowLeft,
  CloudDownload,
  FastForward,
  FolderGit2,
  GitBranch,
  Info,
  LoaderCircle,
  PanelLeft,
  PanelRight,
  Palette,
  Settings,
  Plus,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { useAppearance } from "./appearance";
import type { ThemePreference } from "./appearance";
import { AppearanceSettings } from "./components/AppearanceSettings";
import { AddRepositoryDialog } from "./components/AddRepositoryDialog";
import { FetchSettings } from "./components/FetchSettings";
import { CommitInspector } from "./components/CommitInspector";
import { FileDiffPane } from "./components/FileDiffPane";
import type { DiffStyle } from "./components/FileDiffPane";
import { History } from "./components/History";
import { PaneDivider } from "./components/PaneDivider";
import { RepositoryTree } from "./components/RepositoryTree";
import { readyAdvances } from "./domain/overview";
import { headLabel } from "./domain/repository";
import type { Branch, FullRef } from "./domain/repository";
import { useFetchSettings } from "./fetchSettings";
import { repositoryWarnings, useOverview } from "./overview";
import { macNative } from "./repositories";
import { useWorkspace } from "./useWorkspace";

type AppScreen = "repository" | "settings";
type SettingsSection = "appearance" | "fetching";
const settingsSections = [
  { section: "appearance", label: "Appearance", Icon: Palette },
  { section: "fetching", label: "Fetching", Icon: CloudDownload },
] as const;

export function App({ initialTheme }: { initialTheme: ThemePreference }) {
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
  const [query, setQuery] = useState("");
  const [diffStyle, setDiffStyle] = useState<DiffStyle>("unified");
  const [jump, setJump] = useState<{ reference: FullRef; seq: number } | null>(
    null,
  );
  const searchRef = useRef<HTMLInputElement>(null);
  const sidebarToggleRef = useRef<HTMLButtonElement>(null);
  const inspectorToggleRef = useRef<HTMLButtonElement>(null);
  const settingsRef = useRef<HTMLButtonElement>(null);
  const leaveSettings = useCallback(() => {
    flushSync(() => setScreen("repository"));
    (sidebarOpen ? settingsRef : sidebarToggleRef).current?.focus();
  }, [sidebarOpen]);
  const { workspace, current, fileDiff, closeFile } = app;
  const fileOpen = fileDiff.kind !== "closed";
  const busy = workspace.kind === "loading";
  const snapshot = current?.snapshot ?? null;
  const inspectorVisible = Boolean(snapshot && current && inspectorOpen);
  const activePath =
    snapshot?.root ??
    (workspace.kind === "loading" || workspace.kind === "error"
      ? workspace.path
      : null);
  const openRoot = snapshot?.root ?? null;
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
  const jumped = jump
    ? (snapshot?.branches.find(
        (branch) => branch.reference === jump.reference,
      ) ?? null)
    : null;
  const jumpedUnloaded =
    jumped !== null &&
    snapshot !== null &&
    !snapshot.commits.some((commit) => commit.oid === jumped.oid);
  const refreshRef = useRef(app.refresh);
  useEffect(() => {
    refreshRef.current = app.refresh;
  });
  useEffect(
    () =>
      overviewStore.onRefsChanged((roots) => {
        if (roots.some((root) => root === app.activeRoot))
          void refreshRef.current();
      }),
    [overviewStore, app.activeRoot],
  );
  function showRepository(path: string) {
    setScreen("repository");
    if (path !== snapshot?.root) void app.selectRepository(path);
  }
  function jumpTo(branch: Branch) {
    setQuery("");
    closeFile();
    if (snapshot?.commits.some((commit) => commit.oid === branch.oid))
      app.setSelectedOid(branch.oid);
    setJump((previous) => ({
      reference: branch.reference,
      seq: (previous?.seq ?? 0) + 1,
    }));
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
      disabled={!snapshot}
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
    setQuery("");
    setJump(null);
  }, [snapshot?.root]);
  useEffect(() => {
    function keyboard(event: KeyboardEvent) {
      if (screen === "settings") {
        if (event.key === "Escape") {
          event.preventDefault();
          leaveSettings();
        }
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "o") {
        event.preventDefault();
        setAdding(true);
      }
      if (screen !== "repository") return;
      if (
        !adding &&
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "f" &&
        searchRef.current
      ) {
        event.preventDefault();
        if (fileOpen) flushSync(closeFile);
        searchRef.current.focus();
      }
      if (!adding && event.key === "Escape") {
        if (fileOpen) {
          closeFile();
        } else {
          setQuery("");
          searchRef.current?.blur();
        }
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
            snapshot={snapshot}
            activePath={screen === "repository" ? activePath : null}
            highlighted={
              jumped !== null && jumped.oid === app.selectedOid
                ? jumped.reference
                : null
            }
            browsing={screen === "repository"}
            sync={overview.syncByRoot}
            onSelect={showRepository}
            onJump={jumpTo}
            onRemove={app.removeRepository}
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
                {snapshot ? (
                  <>
                    <span className="repository-name" title={snapshot.root}>
                      {snapshot.name}
                    </span>
                    <span className="breadcrumb-slash">/</span>
                    <GitBranch size={15} />
                    <span
                      className={
                        snapshot.head.kind === "detached"
                          ? "detached-head"
                          : "head-name"
                      }
                      title="Checked-out HEAD. Selecting a branch shows it in the graph without checkout."
                    >
                      {headLabel(snapshot.head)}
                    </span>
                  </>
                ) : (
                  <span className="muted">Workspace</span>
                )}
              </div>
              <div className="toolbar-actions">
                <button
                  className="button secondary add-toolbar"
                  onClick={() => setAdding(true)}
                  title="Add repository (⌘/Ctrl O)"
                >
                  <Plus size={15} />
                  <span>Add repository</span>
                </button>
                {current && (
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => void app.refresh()}
                    title="Reread local Git state. Fetch downloads new commits from remotes."
                  >
                    <RefreshCw size={14} className={busy ? "spin" : ""} />
                    <span>Refresh</span>
                  </button>
                )}
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
            {app.persistenceError && (
              <div className="notice error-notice" role="alert">
                <TriangleAlert size={14} />
                <span>{app.persistenceError}</span>
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
              {snapshot && current ? (
                <>
                  <History
                    snapshot={snapshot}
                    selectedOid={app.selectedOid}
                    revealSeq={jump?.seq ?? 0}
                    query={query}
                    onQuery={setQuery}
                    onSelect={app.setSelectedOid}
                    searchRef={searchRef}
                    busy={busy}
                    hidden={fileOpen}
                  />
                  {fileDiff.kind !== "closed" && (
                    <FileDiffPane
                      state={fileDiff}
                      diffStyle={diffStyle}
                      theme={appearance.resolvedTheme}
                      onDiffStyle={setDiffStyle}
                      onBack={closeFile}
                      onRetry={() => app.openFile(fileDiff.path)}
                    />
                  )}
                </>
              ) : workspace.kind === "loading" ? (
                <div className="workspace-empty" role="status">
                  <LoaderCircle size={28} className="spin" />
                  <h1>Opening repository</h1>
                  <p className="path-label">{workspace.path}</p>
                </div>
              ) : workspace.kind === "error" ? (
                <div className="workspace-empty">
                  <div className="empty-icon error-icon">
                    <TriangleAlert size={32} />
                  </div>
                  <h1>Could not open this repository</h1>
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
          {snapshot && current && inspectorVisible && (
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
              <AppearanceSettings
                preference={appearance.preference}
                onPreferenceChange={appearance.setPreference}
                persistenceError={appearance.persistenceError}
                nativeError={appearance.nativeError}
              />
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
          onAdd={app.addRepository}
          onClose={() => setAdding(false)}
        />
      )}
    </div>
  );
}
