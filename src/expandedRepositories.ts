import { useRef, useState } from "react";
import { z } from "zod";
import type { Catalog } from "./domain/recents";
import { rootSchema } from "./domain/repository";
import type { RepositoryRoot } from "./domain/repository";
import { browserStorage, readStored, writeStored } from "./persisted";

export const EXPANDED_KEY = "l1git.expanded.v1";
const expandedSchema = z.object({
  version: z.literal(1),
  roots: z.array(rootSchema),
});

/** Saved roots that are still in the catalog, else the last repository. */
export function restoreExpanded(
  storage: Pick<Storage, "getItem"> | null,
  catalog: Pick<Catalog, "entries" | "lastRoot">,
): ReadonlySet<RepositoryRoot> {
  const saved = readStored(storage, EXPANDED_KEY, expandedSchema);
  if (saved === null)
    return new Set(catalog.lastRoot === null ? [] : [catalog.lastRoot]);
  const known = new Set(catalog.entries.map((entry) => entry.root));
  return new Set(saved.roots.filter((root) => known.has(root)));
}

export function persistExpanded(
  storage: Pick<Storage, "setItem"> | null,
  roots: ReadonlySet<RepositoryRoot>,
): string | null {
  return writeStored(
    storage,
    EXPANDED_KEY,
    { version: 1, roots: [...roots] },
    "Expanded repositories changed for this session. Could not save them.",
  );
}

export function useExpandedRepositories(catalog: Catalog) {
  const [expanded, setExpandedRoots] = useState(() =>
    restoreExpanded(browserStorage(), catalog),
  );
  const expandedRef = useRef(expanded);
  const [persistenceError, setPersistenceError] = useState<string | null>(null);

  function setExpanded(root: RepositoryRoot, open: boolean) {
    if (expandedRef.current.has(root) === open) return;
    const next = new Set(expandedRef.current);
    if (open) next.add(root);
    else next.delete(root);
    expandedRef.current = next;
    setExpandedRoots(next);
    setPersistenceError(persistExpanded(browserStorage(), next));
  }

  return { expanded, setExpanded, persistenceError };
}
