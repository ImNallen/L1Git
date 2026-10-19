import { describe, expect, it } from "vitest";
import { oidSchema, rootSchema, snapshotSchema } from "./repository";
import { cacheSnapshot, evictSnapshot, restoreSelection } from "./revisit";
import type { SnapshotCache } from "./revisit";

const a = oidSchema.parse("a".repeat(40));
const b = oidSchema.parse("b".repeat(40));
const gone = oidSchema.parse("c".repeat(40));

function snapshot(root: string, oids: string[] = [], observedAt = 0) {
  return snapshotSchema.parse({
    root,
    name: root.slice(1),
    head: { kind: "unborn", reference: "refs/heads/main" },
    branches: [],
    tags: [],
    worktrees: [],
    remotes: [],
    commits: oids.map((oid) => ({
      oid,
      parents: [],
      subject: "",
      author: "A",
      email: "a@example.com",
      timestamp: 0,
    })),
    squashes: [],
    historyTruncated: false,
    observedAt,
  });
}

const order = (cache: SnapshotCache) =>
  [...cache.values()].map((cached) => `${cached.root}@${cached.observedAt}`);

describe("snapshot cache", () => {
  it("keeps the most recently opened snapshots and evicts the oldest", () => {
    let cache: SnapshotCache = new Map();
    cache = cacheSnapshot(cache, snapshot("/a"), 3);
    cache = cacheSnapshot(cache, snapshot("/b"), 3);
    cache = cacheSnapshot(cache, snapshot("/c"), 3);
    cache = cacheSnapshot(cache, snapshot("/a", [], 1), 3);
    expect(order(cache)).toEqual(["/b@0", "/c@0", "/a@1"]);
    cache = cacheSnapshot(cache, snapshot("/d"), 3);
    expect(order(cache)).toEqual(["/c@0", "/a@1", "/d@0"]);
  });

  it("holds eight repositories by default", () => {
    let cache: SnapshotCache = new Map();
    for (let index = 1; index <= 9; index++)
      cache = cacheSnapshot(cache, snapshot(`/${index}`));
    expect([...cache.keys()]).toEqual([
      "/2",
      "/3",
      "/4",
      "/5",
      "/6",
      "/7",
      "/8",
      "/9",
    ]);
  });

  it("evicts a removed repository without touching the input", () => {
    const cache = cacheSnapshot(
      cacheSnapshot(new Map(), snapshot("/a")),
      snapshot("/b"),
    );
    expect(order(evictSnapshot(cache, rootSchema.parse("/a")))).toEqual([
      "/b@0",
    ]);
    expect(order(cache)).toEqual(["/a@0", "/b@0"]);
  });
});

describe("restored selection", () => {
  it("keeps a remembered commit that is still in the snapshot", () => {
    expect(restoreSelection(snapshot("/a", [a, b]), b)).toBe(b);
  });

  it("falls back to the newest commit", () => {
    expect(restoreSelection(snapshot("/a", [a, b]), gone)).toBe(a);
    expect(restoreSelection(snapshot("/a", [a, b]), null)).toBe(a);
    expect(restoreSelection(snapshot("/a"), b)).toBe(null);
  });
});
