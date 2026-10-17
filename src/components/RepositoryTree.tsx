import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Cloud,
  FolderGit2,
  GitBranch,
  Github,
  Plus,
  Search,
  X,
} from "lucide-react";
import type { RecentRepository } from "../domain/recents";
import type {
  Branch,
  FullRef,
  RepositoryRoot,
  RepositorySnapshot,
} from "../domain/repository";

type Props = {
  entries: RecentRepository[];
  snapshot: RepositorySnapshot | null;
  activePath: string | null;
  reference: FullRef | null;
  busy: boolean;
  onSelect: (path: string) => void;
  onBrowse: (reference: FullRef | null) => void;
  onRemove: (root: RepositoryRoot) => void;
  onAdd: () => void;
};

export function RepositoryTree({
  entries,
  snapshot,
  activePath,
  reference,
  busy,
  onSelect,
  onBrowse,
  onRemove,
  onAdd,
}: Props) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<RepositoryRoot>>(new Set());
  const [localOpen, setLocalOpen] = useState(true);
  const [remoteOpen, setRemoteOpen] = useState(true);
  const search = query.toLocaleLowerCase();
  const matches = (value: string) => value.toLocaleLowerCase().includes(search);
  const local =
    snapshot?.branches.filter((branch) => branch.kind === "local") ?? [];
  const remote =
    snapshot?.branches.filter((branch) => branch.kind === "remote") ?? [];
  const activeMatches =
    snapshot?.branches.some((branch) => matches(branch.name)) ?? false;
  const entriesShown = entries.filter(
    (entry) =>
      matches(entry.name) ||
      matches(entry.root) ||
      (entry.root === snapshot?.root && activeMatches),
  );

  function toggle(root: RepositoryRoot) {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(root)) next.delete(root);
      else next.add(root);
      return next;
    });
  }

  function branchRow(branch: Branch) {
    const checkedOut =
      snapshot?.head.kind === "attached" &&
      snapshot.head.reference === branch.reference;
    const BranchIcon = checkedOut
      ? CircleCheck
      : branch.kind === "remote"
        ? Cloud
        : GitBranch;
    return (
      <button
        className={`branch-row ${reference === branch.reference ? "selected" : ""}`}
        key={branch.reference}
        onClick={() => onBrowse(branch.reference)}
        disabled={busy}
        title={`${branch.reference}${branch.kind === "local" && branch.upstream ? ` · Tracks ${branch.upstream}` : ""} · Browse history without checkout`}
        aria-current={reference === branch.reference ? "true" : undefined}
      >
        <BranchIcon size={14} className={checkedOut ? "head-icon" : ""} />
        <span>{branch.name}</span>
        {checkedOut && (
          <span className="branch-head" aria-label="Checked-out branch">
            HEAD
          </span>
        )}
      </button>
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
          const expanded =
            entry.root === snapshot?.root && !collapsed.has(entry.root);
          return (
            <div className="repository-group" key={entry.root}>
              <div className={`repository-row ${active ? "active" : ""}`}>
                <button
                  className="repository-open"
                  title={entry.root}
                  onClick={() => {
                    if (entry.root === snapshot?.root) toggle(entry.root);
                    else onSelect(entry.root);
                  }}
                  aria-expanded={expanded}
                >
                  {expanded ? (
                    <ChevronDown size={13} />
                  ) : (
                    <ChevronRight size={13} />
                  )}
                  <span>{entry.name}</span>
                </button>
                <button
                  className="icon-button remove-repository"
                  onClick={() => onRemove(entry.root)}
                  aria-label={`Remove ${entry.name} from recents`}
                  title="Remove from recents. Repository files stay on disk."
                >
                  <X size={13} />
                </button>
              </div>
              {expanded && snapshot && (
                <div className="repository-branches">
                  <button
                    className={`all-branches ${reference === null ? "selected" : ""}`}
                    disabled={busy}
                    onClick={() => onBrowse(null)}
                  >
                    <GitBranch size={14} />
                    <span>All branches</span>
                  </button>
                  <button
                    className="tree-section"
                    aria-expanded={localOpen}
                    onClick={() => setLocalOpen(!localOpen)}
                  >
                    {localOpen ? (
                      <ChevronDown size={13} />
                    ) : (
                      <ChevronRight size={13} />
                    )}
                    <span>Local branches</span>
                    <span className="count">{local.length}</span>
                  </button>
                  {localOpen && (
                    <div>
                      {local
                        .filter(
                          (branch) =>
                            matches(branch.name) || matches(entry.name),
                        )
                        .map(branchRow)}
                      {snapshot.head.kind === "unborn" && (
                        <div className="branch-row unborn">
                          <GitBranch size={14} />
                          <span>
                            {snapshot.head.reference.replace(
                              /^refs\/heads\//,
                              "",
                            )}
                          </span>
                          <small>unborn</small>
                        </div>
                      )}
                      {local.length > 0 &&
                        !local.some(
                          (branch) =>
                            matches(branch.name) || matches(entry.name),
                        ) && (
                          <p className="tree-hint">
                            No matching local branches
                          </p>
                        )}
                    </div>
                  )}
                  <button
                    className="tree-section"
                    aria-expanded={remoteOpen}
                    onClick={() => setRemoteOpen(!remoteOpen)}
                  >
                    {remoteOpen ? (
                      <ChevronDown size={13} />
                    ) : (
                      <ChevronRight size={13} />
                    )}
                    <span>Remote branches</span>
                    <span className="count">{remote.length}</span>
                  </button>
                  {remoteOpen && (
                    <div>
                      {remote
                        .filter(
                          (branch) =>
                            matches(branch.name) || matches(entry.name),
                        )
                        .map(branchRow)}
                      {remote.length === 0 && (
                        <p className="tree-hint">
                          No remote branches found locally
                        </p>
                      )}
                      {remote.length > 0 &&
                        !remote.some(
                          (branch) =>
                            matches(branch.name) || matches(entry.name),
                        ) && (
                          <p className="tree-hint">
                            No matching remote branches
                          </p>
                        )}
                    </div>
                  )}
                  {snapshot.remotes.length > 0 && (
                    <div className="remote-metadata">
                      {snapshot.remotes.map((remote) => (
                        <div key={remote.name} title={remote.url}>
                          {remote.github ? (
                            <Github size={13} />
                          ) : (
                            <Cloud size={13} />
                          )}
                          <span>
                            {remote.github
                              ? `${remote.github.owner}/${remote.github.repo}`
                              : remote.name}
                          </span>
                          <small>{remote.name}</small>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
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
    </>
  );
}
