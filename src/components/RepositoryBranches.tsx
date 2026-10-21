import { Fragment } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
} from "react";
import {
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Cloud,
  Eye,
  EyeOff,
  Focus,
  Folder,
  FolderOpen,
  GitBranch,
  Laptop,
} from "lucide-react";
import { branchTree } from "../domain/branchTree";
import type { BranchTree } from "../domain/branchTree";
import type { Branch, FullRef, RepositoryRefs } from "../domain/repository";
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

type Props = {
  refs: RepositoryRefs;
  /** Lowercased sidebar search. Empty shows every branch. */
  search: string;
  /** When the repository itself matches the search, all its branches show. */
  repositoryMatches: boolean;
  highlighted: FullRef | null;
  sync: RootSync | undefined;
  /** Explicit open states keyed by `${root}:${section}` and `${root}:${section}:${folder}`. */
  overrides: ReadonlyMap<string, boolean>;
  onOverride: (key: string, open: boolean) => void;
  onJump: (branch: Branch) => void;
  rule: VisibilityRule;
  onRule: (rule: VisibilityRule) => void;
  onMenu: (
    event: ReactMouseEvent<HTMLElement> | ReactKeyboardEvent<HTMLElement>,
    branch: Branch,
  ) => void;
};

export function RepositoryBranches({
  refs: { root, head, branches },
  search,
  repositoryMatches,
  highlighted,
  sync,
  overrides,
  onOverride,
  onJump,
  rule,
  onRule,
  onMenu,
}: Props) {
  const matches = (branch: Branch) =>
    repositoryMatches || normalizeSearch(branch.name).includes(search);
  const local = branches.filter((branch) => branch.kind === "local");
  const remote = branches.filter((branch) => branch.kind === "remote");
  const localShown = local.filter(matches);
  const remoteShown = remote.filter(matches);
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

  function section(kind: Branch["kind"]) {
    const key = `${root}:${kind}`;
    const open = overrides.get(key) ?? true;
    return { key, open, toggle: () => onOverride(key, !open) };
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
                {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                {open ? <FolderOpen size={14} /> : <Folder size={14} />}
                <span>{folder.name}</span>
                <span className="count">{folder.count}</span>
                {!open &&
                  ruleCue(
                    (branch) => branch.kind === kind && holds(branch.name),
                  )}
              </button>
              {open && tree(folder, depth + 1)}
            </Fragment>
          );
        })}
        {node.branches.map((branch) => branchRow(branch, depth))}
      </>
    );
    return tree(branchTree(shown), 0);
  }

  function branchRow(branch: Branch, depth: number) {
    const checkedOut = headReference === branch.reference;
    const counts =
      branch.kind === "local"
        ? sync?.branches.get(branch.reference)
        : undefined;
    const BranchIcon = checkedOut
      ? CircleCheck
      : branch.kind === "remote"
        ? Cloud
        : GitBranch;
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
          onClick={() => onJump(branch)}
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
          <BranchIcon size={14} />
          <span>{branch.name.slice(branch.name.lastIndexOf("/") + 1)}</span>
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
        {localSection.open ? (
          <ChevronDown size={13} />
        ) : (
          <ChevronRight size={13} />
        )}
        <Laptop size={14} />
        <span>Local</span>
        <span className="count">{local.length}</span>
        {!localSection.open && ruleCue((branch) => branch.kind === "local")}
      </button>
      {localSection.open && (
        <div>
          {branchList("local", localShown)}
          {head.kind === "unborn" && (
            <div className="branch-row unborn">
              <GitBranch size={14} />
              <span>{head.reference.replace(/^refs\/heads\//, "")}</span>
              <small>unborn</small>
            </div>
          )}
          {local.length > 0 && localShown.length === 0 && (
            <p className="tree-hint">No matching local branches</p>
          )}
        </div>
      )}
      <button
        className="tree-section"
        aria-expanded={remoteSection.open}
        onClick={remoteSection.toggle}
      >
        {remoteSection.open ? (
          <ChevronDown size={13} />
        ) : (
          <ChevronRight size={13} />
        )}
        <Cloud size={14} />
        <span>Remote</span>
        <span className="count">{remote.length}</span>
        {!remoteSection.open && ruleCue((branch) => branch.kind === "remote")}
      </button>
      {remoteSection.open && (
        <div>
          {branchList("remote", remoteShown)}
          {remote.length === 0 && (
            <p className="tree-hint">No remote branches found locally</p>
          )}
          {remote.length > 0 && remoteShown.length === 0 && (
            <p className="tree-hint">No matching remote branches</p>
          )}
        </div>
      )}
    </div>
  );
}
