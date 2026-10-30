import { useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
} from "react";
import {
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CornerDownLeft,
  Eye,
  EyeOff,
  Focus,
  FolderGit2,
  GitBranchPlus,
  PencilLine,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { branchAsks } from "../domain/operations";
import type { BranchAsk, TagAsk } from "../domain/operations";
import type { RecentRepository } from "../domain/recents";
import { normalizeSearch } from "../domain/search";
import type {
  Branch,
  FullRef,
  Oid,
  RepositoryRefs,
  RepositoryRoot,
  Stash,
  Tag,
} from "../domain/repository";
import { NO_RULE, branchVisibility, toggleRule } from "../domain/visibility";
import type { VisibilityRule } from "../domain/visibility";
import type { RootSync } from "../overview";
import type { RefsState } from "../useRepositoryRefs";
import { ContextMenu, opensMenu } from "./ContextMenu";
import { RepositoryBranches } from "./RepositoryBranches";
import { SyncCounts } from "./SyncCounts";
import { useRovingRows } from "./useRovingRows";

type Props = {
  entries: RecentRepository[];
  expanded: ReadonlySet<RepositoryRoot>;
  refs: ReadonlyMap<RepositoryRoot, RefsState>;
  activePath: string | null;
  /** The branch or tag last jumped to in the open repository. */
  highlighted: { root: RepositoryRoot; reference: FullRef } | null;
  selectedStash: { root: RepositoryRoot; oid: Oid } | null;
  sync: ReadonlyMap<RepositoryRoot, RootSync>;
  onSelect: (root: RepositoryRoot) => void;
  onToggle: (root: RepositoryRoot) => void;
  onJump: (root: RepositoryRoot, target: Branch | Tag) => void;
  onStash: (root: RepositoryRoot, stash: Stash) => void;
  ruleFor: (root: RepositoryRoot) => VisibilityRule;
  onRule: (root: RepositoryRoot, rule: VisibilityRule) => void;
  onRemove: (root: RepositoryRoot) => void;
  onAdd: () => void;
  writable: {
    root: RepositoryRoot;
    checkedOutIn: ReadonlyMap<FullRef, string>;
  } | null;
  onBranchAsk: (ask: BranchAsk) => void;
  onTagAsk: (ask: TagAsk) => void;
  onStashAction: (action: "apply" | "pop" | "drop", stash: Stash) => void;
  onCheckout: (branch: Branch) => void;
};

export function RepositoryTree({
  entries,
  expanded,
  refs,
  activePath,
  highlighted,
  selectedStash,
  sync,
  onSelect,
  onToggle,
  onJump,
  onStash,
  ruleFor,
  onRule,
  onRemove,
  onAdd,
  writable,
  onBranchAsk,
  onTagAsk,
  onStashAction,
  onCheckout,
}: Props) {
  const [query, setQuery] = useState("");
  const tree = useRef<HTMLElement>(null);
  useRovingRows(tree);
  const [menu, setMenu] = useState<{
    target:
      | { kind: "repository"; entry: RecentRepository }
      | { kind: "branch"; root: RepositoryRoot; branch: Branch }
      | { kind: "tag"; root: RepositoryRoot; tag: Tag }
      | { kind: "stash"; root: RepositoryRoot; stash: Stash };
    x: number;
    y: number;
    focus: HTMLElement;
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
  const refMatches = ({
    branches,
    tags,
    stashes,
    submodules,
  }: RepositoryRefs) =>
    [
      ...branches.map((branch) => branch.name),
      ...tags.map((tag) => tag.name),
      ...stashes.flatMap((stash) => [stash.message, stash.name]),
      ...submodules.map((submodule) => submodule.path),
    ].some(matches);
  const entriesShown = entries.filter((entry) => {
    const refs = loaded(entry.root);
    return (
      matches(entry.name) ||
      matches(entry.root) ||
      (refs !== null && refMatches(refs))
    );
  });

  function openMenu(
    event: ReactMouseEvent<HTMLElement> | ReactKeyboardEvent<HTMLElement>,
    target: NonNullable<typeof menu>["target"],
    focus: HTMLElement,
  ) {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    // Keyboard-opened menus have no pointer position, so they open below the row.
    const pointer =
      "clientX" in event && (event.clientX !== 0 || event.clientY !== 0);
    setMenu({
      target,
      x: pointer ? event.clientX : rect.left + 24,
      y: pointer ? event.clientY : rect.bottom,
      focus,
    });
  }

  function repositoryMenu(
    event: ReactMouseEvent<HTMLElement> | ReactKeyboardEvent<HTMLElement>,
    entry: RecentRepository,
  ) {
    const open =
      event.currentTarget.querySelector<HTMLElement>(".repository-open");
    if (open) openMenu(event, { kind: "repository", entry }, open);
  }

  function closeMenu({ returnFocus } = { returnFocus: true }) {
    setMenu(null);
    if (returnFocus) menu?.focus.focus({ preventScroll: true });
  }

  const write = (
    Icon: typeof Plus,
    label: string,
    run: (() => void) | null,
    off: string | null,
  ) =>
    run && (
      <button
        role="menuitem"
        aria-disabled={off !== null}
        title={off ?? undefined}
        onClick={() => {
          if (off !== null) return;
          closeMenu();
          run();
        }}
      >
        <Icon size={14} />
        <span>{label}</span>
        {off !== null && <small className="menu-reason">{off}</small>}
      </button>
    );

  function menuItems(target: NonNullable<typeof menu>["target"]) {
    if (target.kind === "repository")
      return (
        <button
          role="menuitem"
          title="Repository files stay on disk."
          onClick={() => {
            setMenu(null);
            onRemove(target.entry.root);
          }}
        >
          <Trash2 size={14} />
          <span>Remove</span>
        </button>
      );
    if (target.kind === "tag")
      return write(
        Trash2,
        "Delete tag…",
        () => onTagAsk({ kind: "delete", tag: target.tag }),
        writable?.root === target.root
          ? null
          : "Open this repository to change its tags.",
      );
    if (target.kind === "stash") {
      const off =
        writable?.root === target.root
          ? null
          : "Open this repository to change its stashes.";
      return (
        <>
          {write(
            CornerDownLeft,
            "Apply",
            () => onStashAction("apply", target.stash),
            off,
          )}
          {write(
            ArchiveRestore,
            "Pop",
            () => onStashAction("pop", target.stash),
            off,
          )}
          {write(
            Trash2,
            "Drop…",
            () => onStashAction("drop", target.stash),
            off,
          )}
        </>
      );
    }
    const { root, branch } = target;
    const rule = ruleFor(root);
    const asks = branchAsks(branch);
    const elsewhere =
      writable?.root === root
        ? null
        : "Open this repository to change its branches.";
    const checkedOutIn = writable?.checkedOutIn.get(branch.reference);
    const head = loaded(root)?.head;
    const checkedOut =
      head?.kind === "attached" && head.reference === branch.reference
        ? "Checked out"
        : checkedOutIn === undefined
          ? null
          : `Checked out in ${checkedOutIn}`;
    const asking = (ask: BranchAsk | null) => ask && (() => onBranchAsk(ask));
    const state = branchVisibility(rule, branch.reference);
    const apply = (next: VisibilityRule) => () => {
      onRule(root, next);
      closeMenu();
    };
    return (
      <>
        <button
          role="menuitem"
          onClick={apply(toggleRule(rule, "hide", branch.reference))}
        >
          {state === "hidden" ? <Eye size={14} /> : <EyeOff size={14} />}
          <span>{state === "hidden" ? "Show" : "Hide"}</span>
        </button>
        <button
          role="menuitem"
          onClick={apply(toggleRule(rule, "solo", branch.reference))}
        >
          <Focus size={14} />
          <span>{state === "soloed" ? "Stop soloing" : "Solo"}</span>
        </button>
        {rule.kind !== "none" && (
          <button role="menuitem" onClick={apply(NO_RULE)}>
            <Eye size={14} />
            <span>Show all branches</span>
          </button>
        )}
        <div className="menu-separator" role="separator" />
        {write(
          CircleCheck,
          "Check out",
          () => onCheckout(branch),
          elsewhere ?? checkedOut,
        )}
        {write(GitBranchPlus, "New branch…", asking(asks.create), elsewhere)}
        {write(PencilLine, "Rename…", asking(asks.rename), elsewhere)}
        {write(
          Trash2,
          "Delete…",
          asking(asks.delete),
          elsewhere ??
            (checkedOutIn === undefined
              ? null
              : `Checked out in ${checkedOutIn}`),
        )}
      </>
    );
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
        selectedStash={
          selectedStash?.root === entry.root ? selectedStash.oid : null
        }
        sync={sync.get(entry.root)}
        overrides={overrides}
        onOverride={(key, open) =>
          setOverrides((previous) => new Map(previous).set(key, open))
        }
        onJump={(target) => onJump(entry.root, target)}
        onStash={(stash) => onStash(entry.root, stash)}
        rule={ruleFor(entry.root)}
        onRule={(rule) => onRule(entry.root, rule)}
        onMenu={(event, branch) =>
          openMenu(
            event,
            { kind: "branch", root: entry.root, branch },
            event.currentTarget,
          )
        }
        onTagMenu={(event, tag) =>
          openMenu(
            event,
            { kind: "tag", root: entry.root, tag },
            event.currentTarget,
          )
        }
        onStashMenu={(event, stash) =>
          openMenu(
            event,
            { kind: "stash", root: entry.root, stash },
            event.currentTarget,
          )
        }
        onCheckout={writable?.root === entry.root ? onCheckout : null}
      />
    );
  }

  return (
    <>
      <div className="sidebar-search">
        <label className="sidebar-search-field">
          <Search size={15} aria-hidden="true" />
          <input
            aria-label="Filter repositories and refs"
            placeholder="Search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button
          className="icon-button"
          onClick={onAdd}
          title="Add repository"
          aria-label="Add repository"
        >
          <Plus size={18} />
        </button>
      </div>
      <nav
        ref={tree}
        className="repository-tree"
        aria-label="Repositories and branches"
      >
        {entriesShown.map((entry) => {
          const active = entry.root === activePath;
          const open = expanded.has(entry.root);
          const toggleLabel = `${open ? "Collapse" : "Expand"} ${entry.name}`;
          const head = sync.get(entry.root)?.head;
          return (
            <div className="repository-group" key={entry.root}>
              <div
                className={`repository-row ${active ? "active" : ""}`}
                onContextMenu={(event) => repositoryMenu(event, entry)}
                onKeyDown={(event) => {
                  if (opensMenu(event)) repositoryMenu(event, entry);
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
                  onClick={() => {
                    onSelect(entry.root);
                    onToggle(entry.root);
                  }}
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
          label={`${
            menu.target.kind === "repository"
              ? menu.target.entry.name
              : menu.target.kind === "tag"
                ? menu.target.tag.name
                : menu.target.kind === "stash"
                  ? menu.target.stash.name
                  : menu.target.branch.name
          } actions`}
          onClose={closeMenu}
        >
          {menuItems(menu.target)}
        </ContextMenu>
      )}
    </>
  );
}
