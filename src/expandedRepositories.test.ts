import { describe, expect, it } from "vitest";
import {
  EXPANDED_KEY,
  persistExpanded,
  restoreExpanded,
} from "./expandedRepositories";
import { rootSchema } from "./domain/repository";
import type { RepositoryRoot } from "./domain/repository";

const a = rootSchema.parse("/a");
const b = rootSchema.parse("/b");
const c = rootSchema.parse("/c");
const entry = (root: RepositoryRoot) => ({ root, name: root, openedAt: 1 });
const catalog = { entries: [entry(a), entry(b)], lastRoot: b };

describe("stored expanded repositories", () => {
  it.each([
    [null, [b]],
    ["not json", [b]],
    ['{"version":2,"roots":["/a"]}', [b]],
    ['{"version":1,"roots":["relative"]}', [b]],
    ['{"version":1,"roots":[]}', []],
    ['{"version":1,"roots":["/a","/c","/b"]}', [a, b]],
  ])("reads %j as %j", (stored, expected) => {
    expect([...restoreExpanded({ getItem: () => stored }, catalog)]).toEqual(
      expected,
    );
  });

  it("expands nothing by default when no repository was open", () => {
    expect([
      ...restoreExpanded(
        { getItem: () => null },
        { entries: [entry(a)], lastRoot: null },
      ),
    ]).toEqual([]);
  });

  it("saves a versioned set that restores unchanged", () => {
    const saved = new Map<string, string>();
    expect(
      persistExpanded(
        { setItem: (key, value) => void saved.set(key, value) },
        new Set([a, c]),
      ),
    ).toBeNull();
    expect(saved.get(EXPANDED_KEY)).toBe('{"version":1,"roots":["/a","/c"]}');
    expect([
      ...restoreExpanded(
        { getItem: (key) => saved.get(key) ?? null },
        { entries: [entry(a), entry(c)], lastRoot: null },
      ),
    ]).toEqual([a, c]);
  });

  it("reports a write failure without throwing", () => {
    expect(
      persistExpanded(
        {
          setItem: () => {
            throw new Error("quota");
          },
        },
        new Set([a]),
      ),
    ).toBe(
      "Expanded repositories changed for this session. Could not save them.",
    );
  });
});
