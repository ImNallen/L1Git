import { worktreeRowId } from "./graph";
import type { RowId } from "./graph";
import type { Oid, RepositoryRoot, Worktree } from "./repository";
import type { HistoryRow } from "./worktree";

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

export function historyPlace(
  selection: Selection | null,
  worktrees: readonly Worktree[],
): Oid | null {
  if (selection === null) return null;
  if (selection.kind === "commit") return selection.oid;
  const head = worktrees.find(
    (worktree) => worktree.root === selection.root,
  )?.head;
  return head === undefined || head.kind === "unborn" ? null : head.oid;
}

export function selectedRowId(selection: Selection | null): RowId | null {
  if (selection === null) return null;
  return selection.kind === "commit"
    ? selection.oid
    : worktreeRowId(selection.root);
}

export function rowSelection(row: HistoryRow): Selection {
  return row.kind === "commit"
    ? { kind: "commit", oid: row.id }
    : { kind: "worktree", root: row.worktree.root };
}
