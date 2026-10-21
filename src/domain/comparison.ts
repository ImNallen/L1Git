import type { RowId } from "./graph";
import type { Oid, RepositoryRoot, RepositorySnapshot } from "./repository";
import { listsCommit, selectedRowId } from "./selection";
import type { Selection } from "./selection";

export type Comparison = {
  base: { kind: "firstParent" } | { kind: "commit"; oid: Oid };
  target: Selection;
};

export type Compare = {
  root: RepositoryRoot;
  anchor: Selection;
  base: Oid;
  target: Selection;
};

export function singleCommit(oid: Oid): Comparison {
  return { base: { kind: "firstParent" }, target: { kind: "commit", oid } };
}

export function compared({ base, target }: Compare): Comparison {
  return { base: { kind: "commit", oid: base }, target };
}

export function sameComparison(left: Comparison, right: Comparison): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function compareRows(
  loaded: readonly { oid: Oid }[],
  root: RepositoryRoot,
  anchor: Selection,
  other: Selection,
): Compare | null {
  if (anchor.kind === "worktree" && other.kind === "worktree") return null;
  if (anchor.kind === "worktree" && other.kind === "commit")
    return { root, anchor, base: other.oid, target: anchor };
  if (anchor.kind === "commit" && other.kind === "worktree")
    return { root, anchor, base: anchor.oid, target: other };
  if (anchor.kind !== "commit" || other.kind !== "commit") return null;
  const position = (oid: Oid) =>
    loaded.findIndex((commit) => commit.oid === oid);
  const otherIsOlder = position(other.oid) > position(anchor.oid);
  return otherIsOlder
    ? { root, anchor, base: other.oid, target: anchor }
    : { root, anchor, base: anchor.oid, target: other };
}

export function compareListed(
  snapshot: Pick<RepositorySnapshot, "commits" | "stashes" | "worktrees">,
  { base, target }: Compare,
): boolean {
  const has = (oid: Oid) => listsCommit(snapshot, oid);
  return (
    has(base) &&
    (target.kind === "commit"
      ? has(target.oid)
      : snapshot.worktrees.some((worktree) => worktree.root === target.root))
  );
}

export function swapEnds(compare: Compare): Compare | null {
  const { target } = compare;
  if (target.kind !== "commit") return null;
  return {
    ...compare,
    base: target.oid,
    target: { kind: "commit", oid: compare.base },
  };
}

export function comparedRowId(compare: Compare): RowId | null {
  const anchor = selectedRowId(compare.anchor);
  const ends = [compare.base, selectedRowId(compare.target)];
  return ends.find((id) => id !== anchor) ?? null;
}
