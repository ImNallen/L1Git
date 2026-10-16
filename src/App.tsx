import { useEffect, useRef, useState } from "react";
import {
  FolderGit2,
  GitBranch,
  LoaderCircle,
  PanelLeft,
  PanelRight,
  Plus,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { AddRepositoryDialog } from "./components/AddRepositoryDialog";
import { CommitInspector } from "./components/CommitInspector";
import { History } from "./components/History";
import { PaneDivider } from "./components/PaneDivider";
import { RepositoryTree } from "./components/RepositoryTree";
import { headLabel } from "./domain/repository";
import { macNative } from "./repositories";
import { useWorkspace } from "./useWorkspace";

export function App() {
  const app = useWorkspace();
  const [adding, setAdding] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(
    () => window.innerWidth >= 1100,
  );
  const [sidebarWidth, setSidebarWidth] = useState(260);
  const [inspectorWidth, setInspectorWidth] = useState(320);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const { workspace, current } = app;
  const busy = workspace.kind === "loading";
  const snapshot = current?.snapshot ?? null;
  const activePath =
    snapshot?.root ??
    (workspace.kind === "loading" || workspace.kind === "error"
      ? workspace.path
      : null);

  useEffect(() => {
    setQuery("");
  }, [snapshot?.root]);
  useEffect(() => {
    function keyboard(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "o") {
        event.preventDefault();
        setAdding(true);
      }
      if (
        !adding &&
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "f" &&
        searchRef.current
      ) {
        event.preventDefault();
        searchRef.current.focus();
      }
      if (!adding && event.key === "Escape") {
        setQuery("");
        searchRef.current?.blur();
      }
    }
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, [adding]);
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
      {sidebarOpen && (
        <>
          <aside
            className="sidebar"
            style={{ width: sidebarWidth }}
            aria-label="Repository sidebar"
          >
            <div className="brand" data-tauri-drag-region>
              <span className="brand-icon" data-tauri-drag-region>
                L1
              </span>
              <span data-tauri-drag-region>
                L1{" "}
                <span className="muted" data-tauri-drag-region>
                  Git
                </span>
              </span>
            </div>
            <RepositoryTree
              entries={app.catalog.entries}
              snapshot={snapshot}
              activePath={activePath}
              reference={current?.reference ?? null}
              busy={busy}
              onSelect={(path) => void app.selectRepository(path)}
              onBrowse={(reference) => void app.browse(reference)}
              onRemove={app.removeRepository}
              onAdd={() => setAdding(true)}
            />
          </aside>
          <PaneDivider
            label="Resize repository sidebar"
            width={sidebarWidth}
            min={210}
            max={400}
            direction={1}
            onResize={setSidebarWidth}
          />
        </>
      )}
      <main className="workspace">
        <header className="toolbar" data-tauri-drag-region>
          <button
            className={`icon-button ${sidebarOpen ? "toggled" : ""}`}
            onClick={() => setSidebarOpen(!sidebarOpen)}
            title="Toggle repository sidebar"
            aria-label="Toggle repository sidebar"
            aria-pressed={sidebarOpen}
          >
            <PanelLeft size={16} />
          </button>
          <div className="breadcrumb" data-tauri-drag-region>
            {snapshot ? (
              <>
                <span className="toolbar-monogram">
                  {snapshot.name.slice(0, 2).toUpperCase()}
                </span>
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
                  title="Checked-out HEAD. Selecting a branch browses history without checkout."
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
                onClick={() => void app.browse(current.reference)}
                title="Reread local Git state. Does not fetch remote data."
              >
                <RefreshCw size={14} className={busy ? "spin" : ""} />
                <span>Refresh</span>
              </button>
            )}
            <span className="toolbar-separator" />
            <button
              className={`icon-button ${inspectorOpen ? "toggled" : ""}`}
              disabled={!snapshot}
              aria-label="Toggle commit inspector"
              title="Toggle commit inspector"
              aria-pressed={inspectorOpen}
              onClick={() => setInspectorOpen(!inspectorOpen)}
            >
              <PanelRight size={16} />
            </button>
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
            <button onClick={() => void app.browse(null)}>
              Read all branches
            </button>
          </div>
        )}
        <div className="workspace-panes">
          {snapshot && current ? (
            <>
              <History
                snapshot={snapshot}
                reference={current.reference}
                selectedOid={app.selectedOid}
                query={query}
                onQuery={setQuery}
                onSelect={app.setSelectedOid}
                onBrowse={(reference) => void app.browse(reference)}
                searchRef={searchRef}
                busy={busy}
              />
              {inspectorOpen && (
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
                      onClose={() => setInspectorOpen(false)}
                      onRetry={app.retryDetail}
                    />
                  </div>
                </>
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
                Reads local Git data. Your working copy stays yours.
              </div>
            </div>
          )}
        </div>
        <footer className="workspace-status">
          {snapshot ? (
            <>
              <span title={snapshot.root}>{snapshot.root}</span>
              <span>
                Read locally at{" "}
                {new Date(snapshot.observedAt * 1000).toLocaleTimeString(
                  undefined,
                  { hour: "2-digit", minute: "2-digit" },
                )}
                <span className="summary-separator">·</span>Remote refs reflect
                your last fetch
              </span>
            </>
          ) : (
            <>
              <span>Local Git, in focus</span>
              <span>No network required</span>
            </>
          )}
        </footer>
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
