import type { Oid, RepositoryRoot } from "./repository";

export type CommitSelection = { kind: "commit"; oid: Oid };
export type Selection =
  | CommitSelection
  | { kind: "worktree"; root: RepositoryRoot };

export function sameSelection(
  left: Selection | null,
  right: Selection | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.kind === "commit"
    ? right.kind === "commit" && left.oid === right.oid
    : right.kind === "worktree" && left.root === right.root;
}

/** Keeps `previous` when `next` names the same thing, so effects keyed on the selection do not rerun. */
export function stableSelection(
  previous: Selection | null,
  next: Selection,
): Selection {
  return previous !== null && sameSelection(previous, next) ? previous : next;
}
