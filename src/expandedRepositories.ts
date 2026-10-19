import { useRef, useState } from "react";
import { z } from "zod";
import type { Catalog } from "./domain/recents";
import { rootSchema } from "./domain/repository";
import type { RepositoryRoot } from "./domain/repository";

export const EXPANDED_KEY = "l1git.expanded.v1";
const expandedSchema = z.object({
  version: z.literal(1),
  roots: z.array(rootSchema),
});

/** Saved roots that are still in the catalog, else the last repository. */
export function restoreExpanded(
  storage: Pick<Storage, "getItem">,
  catalog: Pick<Catalog, "entries" | "lastRoot">,
): ReadonlySet<RepositoryRoot> {
  const fallback = new Set(catalog.lastRoot === null ? [] : [catalog.lastRoot]);
  try {
    const saved = storage.getItem(EXPANDED_KEY);
    if (saved === null) return fallback;
    const known = new Set(catalog.entries.map((entry) => entry.root));
    return new Set(
      expandedSchema
        .parse(JSON.parse(saved))
        .roots.filter((root) => known.has(root)),
    );
  } catch {
    return fallback;
  }
}

const unsaved =
  "Expanded repositories changed for this session. Could not save them.";

export function persistExpanded(
  storage: Pick<Storage, "setItem">,
  roots: ReadonlySet<RepositoryRoot>,
): string | null {
  try {
    storage.setItem(
      EXPANDED_KEY,
      JSON.stringify({ version: 1, roots: [...roots] }),
    );
    return null;
  } catch {
    return unsaved;
  }
}

export function useExpandedRepositories(catalog: Catalog) {
  const [expanded, setExpandedRoots] = useState(() => {
    try {
      return restoreExpanded(localStorage, catalog);
    } catch {
      return restoreExpanded({ getItem: () => null }, catalog);
    }
  });
  const expandedRef = useRef(expanded);
  const [persistenceError, setPersistenceError] = useState<string | null>(null);

  function setExpanded(root: RepositoryRoot, open: boolean) {
    if (expandedRef.current.has(root) === open) return;
    const next = new Set(expandedRef.current);
    if (open) next.add(root);
    else next.delete(root);
    expandedRef.current = next;
    setExpandedRoots(next);
    try {
      setPersistenceError(persistExpanded(localStorage, next));
    } catch {
      setPersistenceError(unsaved);
    }
  }

  return { expanded, setExpanded, persistenceError };
}
