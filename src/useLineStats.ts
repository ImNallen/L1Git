import { useEffect, useState } from "react";
import * as repositories from "./repositories";
import type {
  Commit,
  LineStats,
  Oid,
  RepositoryRoot,
} from "./domain/repository";

const SETTLE_DELAY = 100;
// A commit ID names its content, so its counts never change and outlive
// refreshes and repository switches.
const known = new Map<Oid, LineStats>();
const pending = new Set<Oid>();

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
    const timer = window.setTimeout(() => {
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
          setSettled((count) => count + 1);
        });
    }, SETTLE_DELAY);
    return () => window.clearTimeout(timer);
  }, [root, commits]);
  return known;
}
