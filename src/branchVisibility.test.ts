import { describe, expect, it } from "vitest";
import {
  VISIBILITY_KEY,
  persistVisibility,
  restoreVisibility,
} from "./branchVisibility";
import { refSchema, rootSchema } from "./domain/repository";
import type { RepositoryRoot } from "./domain/repository";
import type { VisibilityRule } from "./domain/visibility";

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  };
}

const demo = rootSchema.parse("/tmp/demo");
const other = rootSchema.parse("/tmp/other");
const main = refSchema.parse("refs/heads/main");
const remote = refSchema.parse("refs/remotes/origin/feat/x");

describe("saved branch visibility", () => {
  it("restores each repository's rule after a round trip", () => {
    const storage = memoryStorage();
    const rules = new Map<RepositoryRoot, VisibilityRule>([
      [demo, { kind: "solo", refs: new Set([main, remote]) }],
      [other, { kind: "hide", refs: new Set([remote]) }],
    ]);
    expect(persistVisibility(storage, rules)).toBeNull();
    expect(restoreVisibility(storage)).toEqual(rules);
  });

  it.each([
    ["not JSON", "{"],
    ["another version", JSON.stringify({ version: 2, repositories: [] })],
    [
      "an empty rule",
      JSON.stringify({
        version: 1,
        repositories: [{ root: demo, kind: "hide", refs: [] }],
      }),
    ],
    [
      "a relative root",
      JSON.stringify({
        version: 1,
        repositories: [{ root: "demo", kind: "solo", refs: [main] }],
      }),
    ],
  ])("starts with no rules when the saved value is %s", (_, saved) => {
    expect(
      restoreVisibility(memoryStorage({ [VISIBILITY_KEY]: saved })),
    ).toEqual(new Map());
  });

  it("reports a storage failure instead of throwing", () => {
    const full = {
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(persistVisibility(full, new Map())).toMatch(/Could not save/);
  });
});
