import type { RepositoryRoot, RepositorySnapshot } from "./repository";
import type { Selection } from "./selection";

/** A snapshot can hold 50,000 commits, so only a few stay in memory. */
export const SNAPSHOT_CACHE_SIZE = 8;

/** Snapshots by root, least recently used first. */
export type SnapshotCache = ReadonlyMap<RepositoryRoot, RepositorySnapshot>;

/** What a repository showed when it was last open. */
export type RepositoryView = { selection: Selection | null; scrollTop: number };

export const emptyView: RepositoryView = { selection: null, scrollTop: 0 };

export function cacheSnapshot(
  cache: SnapshotCache,
  snapshot: RepositorySnapshot,
  capacity = SNAPSHOT_CACHE_SIZE,
): SnapshotCache {
  const next = new Map(cache);
  next.delete(snapshot.root);
  next.set(snapshot.root, snapshot);
  for (const root of next.keys()) {
    if (next.size <= capacity) break;
    next.delete(root);
  }
  return next;
}

export function evictSnapshot(
  cache: SnapshotCache,
  root: RepositoryRoot,
): SnapshotCache {
  const next = new Map(cache);
  next.delete(root);
  return next;
}

export function restoreSelection(
  snapshot: Pick<RepositorySnapshot, "commits" | "worktrees">,
  remembered: Selection | null,
): Selection | null {
  const kept =
    remembered?.kind === "commit"
      ? snapshot.commits.some((commit) => commit.oid === remembered.oid)
      : remembered?.kind === "worktree" &&
        snapshot.worktrees.some(
          (worktree) => worktree.root === remembered.root,
        );
  if (kept) return remembered;
  const newest = snapshot.commits[0];
  return newest ? { kind: "commit", oid: newest.oid } : null;
}
