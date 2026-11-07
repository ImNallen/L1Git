import { useEffect, useState } from "react";
import * as repositories from "./repositories";
import type {
  Commit,
  LineStats,
  Oid,
  RepositoryRoot,
} from "./domain/repository";

const SETTLE_DELAY = 100;
// A commit's counts outlive refreshes, but each repository's attributes and
// diff drivers decide which files count as binary, so caches stay per root.
const caches = new Map<
  RepositoryRoot,
  { known: Map<Oid, LineStats>; pending: Set<Oid>; listeners: Set<() => void> }
>();

function cacheOf(root: RepositoryRoot) {
  let cache = caches.get(root);
  if (!cache) {
    cache = { known: new Map(), pending: new Set(), listeners: new Set() };
    caches.set(root, cache);
  }
  return cache;
}

/**
 * Line counts for the rendered commits. Reads the missing ones in one batch
 * once the window stops moving. A commit Git cannot read stays unknown.
 */
export function useLineStats(
  root: RepositoryRoot,
  commits: readonly Commit[],
): ReadonlyMap<Oid, LineStats> {
  const [, setSettled] = useState(0);
  useEffect(() => {
    const cache = cacheOf(root);
    const notify = () => setSettled((count) => count + 1);
    cache.listeners.add(notify);
    return () => {
      cache.listeners.delete(notify);
    };
  }, [root]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const { known, pending } = cacheOf(root);
      const batch = commits
        .map((commit) => commit.oid)
        .filter((oid) => !known.has(oid) && !pending.has(oid));
      if (batch.length === 0) return;
      for (const oid of batch) pending.add(oid);
      void repositories
        .lineStats(root, batch)
        .then(
          (stats) => {
            for (const stat of stats) known.set(stat.oid, stat);
          },
          () => undefined,
        )
        .finally(() => {
          for (const oid of batch) pending.delete(oid);
          for (const notify of cacheOf(root).listeners) notify();
        });
    }, SETTLE_DELAY);
    return () => window.clearTimeout(timer);
  }, [root, commits]);
  return cacheOf(root).known;
}
