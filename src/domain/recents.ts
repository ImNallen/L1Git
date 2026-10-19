import { z } from "zod";
import { rootSchema } from "./repository";
import type { RepositoryRoot, RepositorySnapshot } from "./repository";

export const RECENTS_KEY = "l1git.recents.v1";
const recentSchema = z.object({
  root: rootSchema,
  name: z.string().min(1),
  openedAt: z.number().int().nonnegative(),
});
const catalogSchema = z.object({
  version: z.literal(1),
  entries: z.array(recentSchema).max(50),
  lastRoot: rootSchema.nullable(),
});
export type RecentRepository = z.infer<typeof recentSchema>;
export type Catalog = z.infer<typeof catalogSchema>;
export const emptyCatalog: Catalog = {
  version: 1,
  entries: [],
  lastRoot: null,
};
type StorageReader = Pick<Storage, "getItem">;
type StorageWriter = Pick<Storage, "setItem">;

export function restoreCatalog(storage: StorageReader): {
  catalog: Catalog;
  error: string | null;
} {
  try {
    const saved = storage.getItem(RECENTS_KEY);
    if (saved === null) return { catalog: emptyCatalog, error: null };
    const catalog = catalogSchema.parse(JSON.parse(saved));
    const entries = catalog.entries.filter(
      (entry, index, entries) =>
        entries.findIndex((other) => other.root === entry.root) === index,
    );
    return {
      catalog: {
        ...catalog,
        entries,
        lastRoot: entries.some((entry) => entry.root === catalog.lastRoot)
          ? catalog.lastRoot
          : null,
      },
      error: null,
    };
  } catch {
    return {
      catalog: emptyCatalog,
      error:
        "Saved repositories could not be read. Add a repository again to replace the saved list.",
    };
  }
}

export function remember(
  catalog: Catalog,
  snapshot: Pick<RepositorySnapshot, "root" | "name">,
  now = Date.now(),
): Catalog {
  const entry = { root: snapshot.root, name: snapshot.name, openedAt: now };
  const known = catalog.entries.some(({ root }) => root === snapshot.root);
  return {
    version: 1,
    entries: known
      ? catalog.entries.map((existing) =>
          existing.root === snapshot.root ? entry : existing,
        )
      : [...catalog.entries, entry].slice(-50),
    lastRoot: snapshot.root,
  };
}

export function forget(catalog: Catalog, root: RepositoryRoot): Catalog {
  return {
    ...catalog,
    entries: catalog.entries.filter((entry) => entry.root !== root),
    lastRoot: catalog.lastRoot === root ? null : catalog.lastRoot,
  };
}

export function persistCatalog(
  storage: StorageWriter,
  catalog: Catalog,
): string | null {
  try {
    storage.setItem(RECENTS_KEY, JSON.stringify(catalog));
    return null;
  } catch {
    return "The repository list could not be saved. Allow local storage to restore repositories after restart.";
  }
}
