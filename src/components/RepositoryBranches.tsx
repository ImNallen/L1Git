import { Collapse } from "./Collapse";
import { WorkspaceIcon } from "./WorkspaceIcon";
import { Fragment, useRef } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
  MouseEvent as ReactMouseEvent,
} from "react";
import { ChevronRight, Eye, EyeOff, Focus, Package } from "lucide-react";
import { branchTree } from "../domain/branchTree";
import type { BranchTree } from "../domain/branchTree";
import type {
  Branch,
  FullRef,
  Oid,
  RepositoryRefs,
  Stash,
  Tag,
} from "../domain/repository";
import { shortBranch } from "../domain/refs";
import { normalizeSearch } from "../domain/search";
import { branchVisibility, toggleRule } from "../domain/visibility";
import type { VisibilityRule } from "../domain/visibility";
import type { RootSync } from "../overview";
import { opensMenu } from "./ContextMenu";
import { SyncCounts } from "./SyncCounts";

declare module "react" {
  interface CSSProperties {
    "--depth"?: number;
  }
}

const tagOrder = new Intl.Collator(undefined, { numeric: true });
/** Git starts each stash message with the branch it was made on, which the title keeps. */
const stashPrefix = /^(?:WIP on|On) [^:]*: /;

type Props = {
  refs: RepositoryRefs;
  /** Lowercased sidebar search. Empty shows every branch. */
  search: string;
  /** When the repository itself matches the search, all its branches show. */
  repositoryMatches: boolean;
  highlighted: FullRef | null;
  selectedStash: Oid | null;
  sync: RootSync | undefined;
  /** Explicit open states keyed by `${root}:${section}` and `${root}:${section}:${folder}`. */
  overrides: ReadonlyMap<string, boolean>;
  onOverride: (key: string, open: boolean) => void;
  onJump: (target: Branch | Tag) => void;
  onStash: (stash: Stash) => void;
  rule: VisibilityRule;
  onRule: (rule: VisibilityRule) => void;
  onMenu: (
    event: ReactMouseEvent<HTMLElement> | ReactKeyboardEvent<HTMLElement>,
    branch: Branch,
  ) => void;
  onTagMenu: (
    event: ReactMouseEvent<HTMLElement> | ReactKeyboardEvent<HTMLElement>,
    tag: Tag,
  ) => void;
  onStashMenu: (
    event: ReactMouseEvent<HTMLElement> | ReactKeyboardEvent<HTMLElement>,
    stash: Stash,
  ) => void;
  onCheckout: ((branch: Branch) => void) | null;
};

export function RepositoryBranches({
  refs: { root, head, branches, tags, stashes, submodules },
  search,
  repositoryMatches,
  highlighted,
  selectedStash,
  sync,
  overrides,
  onOverride,
  onJump,
  onStash,
  rule,
  onRule,
  onMenu,
  onTagMenu,
  onStashMenu,
  onCheckout,
}: Props) {
  const checkableAtFirstClick = useRef<FullRef | null>(null);
  const matches = (...values: string[]) =>
    repositoryMatches ||
    values.some((value) => normalizeSearch(value).includes(search));
  const local = branches.filter((branch) => branch.kind === "local");
  const remote = branches.filter((branch) => branch.kind === "remote");
  const localShown = local.filter((branch) => matches(branch.name));
  const remoteShown = remote.filter((branch) => matches(branch.name));
  const tagsShown = tags
    .filter((tag) => matches(tag.name))
    .sort((left, right) => tagOrder.compare(left.name, right.name));
  const stashesShown = stashes.filter((stash) =>
    matches(stash.message, stash.name),
  );
  const submodulesShown = submodules.filter((submodule) =>
    matches(submodule.path),
  );
  const headReference = head.kind === "attached" ? head.reference : null;
  const ruled =
    rule.kind === "none"
      ? []
      : branches.filter((branch) => rule.refs.has(branch.reference));

  function ruleCue(holds: (branch: Branch) => boolean) {
    if (rule.kind === "none" || !ruled.some(holds)) return null;
    const label =
      rule.kind === "hide" ? "Holds hidden branches" : "Holds soloed branches";
    const Icon = rule.kind === "hide" ? EyeOff : Focus;
    return (
      <span
        className={`rule-cue ${rule.kind}`}
        role="img"
        aria-label={label}
        title={label}
      >
        <Icon size={12} />
      </span>
    );
  }

  function section(kind: string) {
    const key = `${root}:${kind}`;
    const open =
      search.length > 0 ||
      (overrides.get(key) ?? (kind === "local" || kind === "remote"));
    return { key, open, toggle: () => onOverride(key, !open) };
  }

  function refSection(
    kind: string,
    label: string,
    icon: ReactNode,
    total: number,
    rows: ReactNode[],
  ) {
    if (total === 0 && kind === "submodule") return null;
    const { open, toggle } = section(kind);
    return (
      <>
        <button className="tree-section" aria-expanded={open} onClick={toggle}>
          <ChevronRight className="motion-chevron" size={13} />
          {icon}
          <span>{label}</span>
          <span className="count">{total}</span>
        </button>
        <Collapse open={open}>
          {rows}
          {rows.length === 0 && (
            <p className="tree-hint">No matching {label.toLowerCase()}</p>
          )}
        </Collapse>
      </>
    );
  }

  function tagRow(tag: Tag) {
    const selected = highlighted === tag.reference;
    return (
      <button
        key={tag.reference}
        className={`branch-row ${selected ? "selected" : ""}`}
        onClick={() => onJump(tag)}
        onContextMenu={(event) => onTagMenu(event, tag)}
        onKeyDown={(event) => {
          if (opensMenu(event)) onTagMenu(event, tag);
        }}
        title={`${tag.reference} · Show in graph`}
        aria-current={selected ? "true" : undefined}
      >
        <WorkspaceIcon name="Tag" />
        <span className="branch-label">{tag.name}</span>
      </button>
    );
  }

  function stashRow(stash: Stash) {
    const selected = selectedStash === stash.oid;
    return (
      <button
        key={stash.name}
        className={`branch-row stash-row ${selected ? "selected" : ""}`}
        onClick={() => onStash(stash)}
        onContextMenu={(event) => onStashMenu(event, stash)}
        onKeyDown={(event) => {
          if (opensMenu(event)) onStashMenu(event, stash);
        }}
        title={`${stash.name} · ${stash.message} · Show changes`}
        aria-current={selected ? "true" : undefined}
      >
        <WorkspaceIcon name="Stash" />
        <span className="branch-label">
          {stash.message.replace(stashPrefix, "")}
        </span>
        <small className="ref-detail">{stash.name}</small>
      </button>
    );
  }

  function branchList(kind: Branch["kind"], shown: Branch[]) {
    const nameOf = (reference: FullRef | null) =>
      shown.find((branch) => branch.reference === reference)?.name;
    const headName = nameOf(headReference);
    const highlightedName = nameOf(highlighted);
    const tree = (node: BranchTree, depth: number) => (
      <>
        {node.folders.map((folder) => {
          const key = `${root}:${kind}:${folder.path}`;
          const holds = (name: string | undefined) =>
            name?.startsWith(`${folder.path}/`) ?? false;
          const holdsHead = holds(headName);
          const open =
            search !== "" ||
            (overrides.get(key) ?? (holdsHead || holds(highlightedName)));
          return (
            <Fragment key={key}>
              <button
                className={`branch-row branch-folder ${!open && holdsHead ? "head" : ""}`}
                style={{ "--depth": depth }}
                aria-expanded={open}
                disabled={search !== ""}
                title={folder.path}
                onClick={() => onOverride(key, !open)}
              >
                <ChevronRight className="motion-chevron" size={13} />
                <WorkspaceIcon
                  name={kind === "remote" && depth === 0 ? "Cloud" : "Folder"}
                />
                <span className="branch-label">{folder.name}</span>
                <span className="count">{folder.count}</span>
                {!open &&
                  ruleCue(
                    (branch) => branch.kind === kind && holds(branch.name),
                  )}
              </button>
              <Collapse open={open}>{tree(folder, depth + 1)}</Collapse>
            </Fragment>
          );
        })}
        {node.branches.map((branch) => branchRow(branch, depth))}
      </>
    );
    const checkedOut =
      kind === "local"
        ? shown.find((branch) => branch.reference === headReference)
        : undefined;
    return (
      <>
        {checkedOut && branchRow(checkedOut, 0)}
        {tree(branchTree(shown.filter((branch) => branch !== checkedOut)), 0)}
      </>
    );
  }

  function branchRow(branch: Branch, depth: number) {
    const checkedOut = headReference === branch.reference;
    const counts =
      branch.kind === "local"
        ? sync?.branches.get(branch.reference)
        : undefined;
    const selected = highlighted === branch.reference;
    const state = branchVisibility(rule, branch.reference);
    const toggle =
      state === "soloed" || (state === "shown" && rule.kind === "solo")
        ? {
            kind: "solo" as const,
            Icon: Focus,
            label: `${state === "soloed" ? "Stop soloing" : "Solo"} ${branch.name}`,
          }
        : {
            kind: "hide" as const,
            Icon: state === "hidden" ? EyeOff : Eye,
            label: `${state === "hidden" ? "Show" : "Hide"} ${branch.name}`,
          };
    return (
      <div className={`branch-item ${state}`} key={branch.reference}>
        <button
          className={`branch-row ${selected ? "selected" : ""} ${checkedOut ? "head" : ""}`}
          style={{ "--depth": depth }}
          onClick={(event) => {
            if (event.detail > 1) return;
            checkableAtFirstClick.current =
              onCheckout && !checkedOut ? branch.reference : null;
            onJump(branch);
          }}
          onDoubleClick={(event) => {
            if (checkableAtFirstClick.current !== branch.reference) return;
            checkableAtFirstClick.current = null;
            event.currentTarget.focus();
            onCheckout?.(branch);
          }}
          onContextMenu={(event) => onMenu(event, branch)}
          onKeyDown={(event) => {
            if (opensMenu(event)) onMenu(event, branch);
          }}
          title={`${branch.reference}${branch.kind === "local" && branch.upstream ? ` · Tracks ${branch.upstream}` : ""} · Show in graph`}
          aria-current={selected ? "true" : undefined}
          aria-description={
            state === "shown"
              ? undefined
              : state === "hidden"
                ? "Hidden in the graph"
                : "Soloed in the graph"
          }
        >
          <WorkspaceIcon name={checkedOut ? "Check" : "Branch"} />
          <span className="branch-label">
            {checkedOut
              ? branch.name
              : branch.name.slice(branch.name.lastIndexOf("/") + 1)}
          </span>
          {checkedOut && (
            <span className="branch-head" aria-label="Checked-out branch">
              HEAD
            </span>
          )}
          {counts && <SyncCounts divergence={counts} />}
        </button>
        <button
          className="branch-visibility"
          tabIndex={-1}
          aria-label={toggle.label}
          title={toggle.label}
          onClick={() =>
            onRule(toggleRule(rule, toggle.kind, branch.reference))
          }
        >
          <toggle.Icon size={13} />
        </button>
      </div>
    );
  }

  const localSection = section("local");
  const remoteSection = section("remote");
  return (
    <div className="repository-branches">
      <button
        className="tree-section"
        aria-expanded={localSection.open}
        onClick={localSection.toggle}
      >
        <ChevronRight className="motion-chevron" size={13} />
        <WorkspaceIcon name="Branch" />
        <span>Local</span>
        <span className="count">{local.length}</span>
        {!localSection.open && ruleCue((branch) => branch.kind === "local")}
      </button>
      <Collapse open={localSection.open}>
        {branchList("local", localShown)}
        {head.kind === "unborn" && (
          <div className="branch-row unborn">
            <WorkspaceIcon name="Branch" />
            <span className="branch-label">{shortBranch(head.reference)}</span>
            <small>unborn</small>
          </div>
        )}
        {local.length > 0 && localShown.length === 0 && (
          <p className="tree-hint">No matching local branches</p>
        )}
      </Collapse>
      <button
        className="tree-section"
        aria-expanded={remoteSection.open}
        onClick={remoteSection.toggle}
      >
        <ChevronRight className="motion-chevron" size={13} />
        <WorkspaceIcon name="Cloud" />
        <span>Remote</span>
        <span className="count">{remote.length}</span>
        {!remoteSection.open && ruleCue((branch) => branch.kind === "remote")}
      </button>
      <Collapse open={remoteSection.open}>
        {branchList("remote", remoteShown)}
        {remote.length === 0 && (
          <p className="tree-hint">No remote branches found locally</p>
        )}
        {remote.length > 0 && remoteShown.length === 0 && (
          <p className="tree-hint">No matching remote branches</p>
        )}
      </Collapse>
      {refSection(
        "tag",
        "Tags",
        <WorkspaceIcon name="Tag" />,
        tags.length,
        tagsShown.map(tagRow),
      )}
      {refSection(
        "stash",
        "Stashes",
        <WorkspaceIcon name="Stash" />,
        stashes.length,
        stashesShown.map(stashRow),
      )}
      {refSection(
        "submodule",
        "Submodules",
        <Package size={16} />,
        submodules.length,
        submodulesShown.map((submodule) => (
          <div
            key={submodule.path}
            className="branch-row static"
            title={`${submodule.path} · Records ${submodule.oid}`}
          >
            <Package size={14} />
            <span className="branch-label">{submodule.path}</span>
            <small className="ref-detail">{submodule.oid.slice(0, 7)}</small>
          </div>
        )),
      )}
    </div>
  );
}
