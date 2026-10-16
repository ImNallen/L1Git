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
