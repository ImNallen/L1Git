import { useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
} from "react";
import {
  ChevronDown,
  ChevronRight,
  FolderGit2,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import type { RecentRepository } from "../domain/recents";
import { normalizeSearch } from "../domain/search";
import type { Branch, FullRef, RepositoryRoot } from "../domain/repository";
import type { RootSync } from "../overview";
import type { RefsState } from "../useRepositoryRefs";
import { ContextMenu } from "./ContextMenu";
import { RepositoryBranches } from "./RepositoryBranches";
import { SyncCounts } from "./SyncCounts";

type Props = {
  entries: RecentRepository[];
  expanded: ReadonlySet<RepositoryRoot>;
  refs: ReadonlyMap<RepositoryRoot, RefsState>;
  activePath: string | null;
  /** The branch last jumped to in the open repository. */
  highlighted: { root: RepositoryRoot; reference: FullRef } | null;
  sync: ReadonlyMap<RepositoryRoot, RootSync>;
  onSelect: (root: RepositoryRoot) => void;
  onToggle: (root: RepositoryRoot) => void;
  onJump: (root: RepositoryRoot, branch: Branch) => void;
  onRemove: (root: RepositoryRoot) => void;
  onAdd: () => void;
};

export function RepositoryTree({
  entries,
  expanded,
  refs,
  activePath,
  highlighted,
  sync,
  onSelect,
  onToggle,
  onJump,
  onRemove,
  onAdd,
}: Props) {
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<{
    entry: RecentRepository;
    x: number;
    y: number;
    trigger: HTMLElement;
  } | null>(null);
  // Explicit section and folder toggles. An absent key falls back to the default.
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(
    new Map(),
  );
  const search = normalizeSearch(query);
  const matches = (value: string) => normalizeSearch(value).includes(search);
  const loaded = (root: RepositoryRoot) => {
    const state = expanded.has(root) ? refs.get(root) : undefined;
    return state?.kind === "ready" ? state.refs : null;
  };
  const entriesShown = entries.filter(
    (entry) =>
      matches(entry.name) ||
      matches(entry.root) ||
      (loaded(entry.root)?.branches.some((branch) => matches(branch.name)) ??
        false),
  );

  function openMenu(
    event: ReactMouseEvent<HTMLElement> | ReactKeyboardEvent<HTMLElement>,
    entry: RecentRepository,
  ) {
    event.preventDefault();
    const trigger = event.currentTarget;
    const rect = trigger.getBoundingClientRect();
    // Keyboard-opened menus have no pointer position, so they open below the row.
    const pointer =
      "clientX" in event && (event.clientX !== 0 || event.clientY !== 0);
    setMenu({
      entry,
      x: pointer ? event.clientX : rect.left + 24,
      y: pointer ? event.clientY : rect.bottom,
      trigger,
    });
  }

  function branches(entry: RecentRepository) {
    const state = refs.get(entry.root);
    if (state === undefined || state.kind === "loading")
      return (
        <p className="tree-hint" role="status">
          Loading branches…
        </p>
      );
    if (state.kind === "error")
      return <p className="tree-hint">{state.problem.message}</p>;
    return (
      <RepositoryBranches
        refs={state.refs}
        search={search}
        repositoryMatches={matches(entry.name)}
        highlighted={
          highlighted?.root === entry.root ? highlighted.reference : null
        }
        sync={sync.get(entry.root)}
        overrides={overrides}
        onOverride={(key, open) =>
          setOverrides((previous) => new Map(previous).set(key, open))
        }
        onJump={(branch) => onJump(entry.root, branch)}
      />
    );
  }

  return (
    <>
      <div className="sidebar-search">
        <Search size={15} />
        <input
          aria-label="Filter repositories and branches"
          placeholder="Search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button
          className="icon-button"
          onClick={onAdd}
          title="Add repository"
          aria-label="Add repository"
        >
          <Plus size={18} />
        </button>
      </div>
      <nav className="repository-tree" aria-label="Repositories and branches">
        {entriesShown.map((entry) => {
          const active = entry.root === activePath;
          const open = expanded.has(entry.root);
          const toggleLabel = `${open ? "Collapse" : "Expand"} ${entry.name}`;
          const head = sync.get(entry.root)?.head;
          return (
            <div className="repository-group" key={entry.root}>
              <div
                className={`repository-row ${active ? "active" : ""}`}
                onContextMenu={(event) => openMenu(event, entry)}
                onKeyDown={(event) => {
                  if (
                    event.key === "ContextMenu" ||
                    (event.shiftKey && event.key === "F10")
                  )
                    openMenu(event, entry);
                }}
              >
                <button
                  className="repository-toggle"
                  aria-expanded={open}
                  aria-label={toggleLabel}
                  title={toggleLabel}
                  onClick={() => onToggle(entry.root)}
                >
                  {open ? (
                    <ChevronDown size={13} />
                  ) : (
                    <ChevronRight size={13} />
                  )}
                </button>
                <button
                  className="repository-open"
                  title={entry.root}
                  aria-current={active ? "true" : undefined}
                  onClick={() => onSelect(entry.root)}
                >
                  <span>{entry.name}</span>
                </button>
                {head && (
                  <SyncCounts divergence={head.divergence} branch={head.name} />
                )}
              </div>
              {open && branches(entry)}
            </div>
          );
        })}
        {entries.length === 0 && (
          <div className="sidebar-empty">
            <FolderGit2 size={24} />
            <p>Your working copies live here.</p>
            <button onClick={onAdd}>Add a repository</button>
          </div>
        )}
        {entries.length > 0 && entriesShown.length === 0 && (
          <p className="tree-hint">No repositories or branches match.</p>
        )}
      </nav>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={`${menu.entry.name} actions`}
          onClose={() => {
            setMenu(null);
            menu.trigger
              .querySelector<HTMLElement>(".repository-open")
              ?.focus({ preventScroll: true });
          }}
        >
          <button
            role="menuitem"
            title="Repository files stay on disk."
            onClick={() => {
              setMenu(null);
              onRemove(menu.entry.root);
            }}
          >
            <Trash2 size={14} />
            <span>Remove</span>
          </button>
        </ContextMenu>
      )}
    </>
  );
}
