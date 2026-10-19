import type { Oid, RepositoryRoot, RepositorySnapshot } from "./repository";

/** A snapshot can hold 50,000 commits, so only a few stay in memory. */
export const SNAPSHOT_CACHE_SIZE = 8;

/** Snapshots by root, least recently used first. */
export type SnapshotCache = ReadonlyMap<RepositoryRoot, RepositorySnapshot>;

/** What a repository showed when it was last open. */
export type RepositoryView = { selectedOid: Oid | null; scrollTop: number };

export const emptyView: RepositoryView = { selectedOid: null, scrollTop: 0 };

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

/** The remembered commit if the snapshot still has it, else the newest. */
export function restoreSelection(
  snapshot: Pick<RepositorySnapshot, "commits">,
  remembered: Oid | null,
): Oid | null {
  return snapshot.commits.some((commit) => commit.oid === remembered)
    ? remembered
    : (snapshot.commits[0]?.oid ?? null);
}
