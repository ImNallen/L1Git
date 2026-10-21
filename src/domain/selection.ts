import type { Oid, RepositoryRoot } from "./repository";

export type Selection =
  | { kind: "commit"; oid: Oid }
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
