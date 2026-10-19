import { describe, expect, it } from "vitest";
import {
  emptyCatalog,
  forget,
  persistCatalog,
  remember,
  restoreCatalog,
} from "./recents";
import { rootSchema } from "./repository";

const root = rootSchema.parse("/canonical/repo");
const linked = rootSchema.parse("/canonical/linked");

describe("saved repositories", () => {
  it("deduplicates canonical roots, preserves linked worktrees, and restores the last selection", () => {
    let catalog = remember(emptyCatalog, { root, name: "repo" }, 1);
    catalog = remember(catalog, { root: linked, name: "linked" }, 2);
    catalog = remember(catalog, { root, name: "renamed" }, 3);
    expect(catalog.entries).toEqual([
      { root, name: "renamed", openedAt: 3 },
      { root: linked, name: "linked", openedAt: 2 },
    ]);
    let saved = "";
    expect(
      persistCatalog(
        {
          setItem: (_key, value) => {
            saved = value;
          },
        },
        catalog,
      ),
    ).toBeNull();
    expect(restoreCatalog({ getItem: () => saved })).toEqual({
      catalog,
      error: null,
    });
    const removed = forget(catalog, root);
    expect(removed.entries).toEqual([
      { root: linked, name: "linked", openedAt: 2 },
    ]);
    expect(removed.lastRoot).toBeNull();
  });

  it("keeps every repository in place when one is reopened and appends new ones", () => {
    const a = rootSchema.parse("/a");
    const b = rootSchema.parse("/b");
    const c = rootSchema.parse("/c");
    let catalog = remember(emptyCatalog, { root: a, name: "a" }, 1);
    catalog = remember(catalog, { root: b, name: "b" }, 2);
    catalog = remember(catalog, { root: c, name: "c" }, 3);
    catalog = remember(catalog, { root: b, name: "b2" }, 4);
    catalog = remember(catalog, { root: c, name: "c" }, 5);
    expect(catalog).toEqual({
      version: 1,
      entries: [
        { root: a, name: "a", openedAt: 1 },
        { root: b, name: "b2", openedAt: 4 },
        { root: c, name: "c", openedAt: 5 },
      ],
      lastRoot: c,
    });
  });

  it("drops the first repository only when a new one overflows the 50 saved", () => {
    const roots = Array.from({ length: 50 }, (_, index) =>
      rootSchema.parse(`/repo-${index}`),
    );
    const first = rootSchema.parse("/repo-0");
    const overflow = rootSchema.parse("/repo-50");
    let catalog = emptyCatalog;
    for (const [index, root] of roots.entries())
      catalog = remember(catalog, { root, name: `repo-${index}` }, index);
    catalog = remember(catalog, { root: first, name: "repo-0" }, 100);
    expect(catalog.entries.map((entry) => entry.root)).toEqual(roots);
    catalog = remember(catalog, { root: overflow, name: "repo-50" }, 101);
    expect(catalog.entries.map((entry) => entry.root)).toEqual([
      ...roots.slice(1),
      overflow,
    ]);
  });

  it("rejects malformed or unsupported storage and reports failed writes", () => {
    for (const value of [
      "{",
      '{"version":2,"entries":[]}',
      '{"version":1,"entries":[{"root":3}],"lastRoot":null}',
    ]) {
      expect(restoreCatalog({ getItem: () => value }).catalog).toEqual(
        emptyCatalog,
      );
      expect(restoreCatalog({ getItem: () => value }).error).toContain(
        "could not be read",
      );
    }
    expect(
      persistCatalog(
        {
          setItem: () => {
            throw new Error("blocked");
          },
        },
        emptyCatalog,
      ),
    ).toContain("could not be saved");
  });
});
