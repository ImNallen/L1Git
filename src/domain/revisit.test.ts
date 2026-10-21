import { describe, expect, it } from "vitest";
import { oidSchema, rootSchema, snapshotSchema } from "./repository";
import { cacheSnapshot, evictSnapshot, restoreSelection } from "./revisit";
import type { SnapshotCache } from "./revisit";
import type { Selection } from "./selection";
import type { StatusEntry } from "./repository";
import type { ChangesByWorktree } from "./worktree";

const a = oidSchema.parse("a".repeat(40));
const b = oidSchema.parse("b".repeat(40));
const gone = oidSchema.parse("c".repeat(40));

function snapshot(
  root: string,
  oids: string[] = [],
  observedAt = 0,
  worktrees: string[] = [],
) {
  return snapshotSchema.parse({
    root,
    name: root.slice(1),
    head: { kind: "unborn", reference: "refs/heads/main" },
    branches: [],
    tags: [],
    worktrees: worktrees.map((worktree) => ({
      root: worktree,
      name: worktree.slice(1),
      head: { kind: "unborn", reference: "refs/heads/main" },
      current: false,
    })),
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
  const none: ChangesByWorktree = new Map();
  const commit = (oid: typeof a): Selection => ({ kind: "commit", oid });
  const worktree = (root: string): Selection => ({
    kind: "worktree",
    root: rootSchema.parse(root),
  });

  it("keeps a remembered commit that is still in the snapshot", () => {
    const remembered = commit(b);
    expect(restoreSelection(snapshot("/a", [a, b]), remembered, none)).toBe(
      remembered,
    );
  });

  it("falls back to the newest commit", () => {
    expect(
      restoreSelection(snapshot("/a", [a, b]), commit(gone), none),
    ).toEqual(commit(a));
    expect(restoreSelection(snapshot("/a", [a, b]), null, none)).toEqual(
      commit(a),
    );
    expect(restoreSelection(snapshot("/a"), commit(b), none)).toBe(null);
  });

  it("keeps a remembered worktree that the snapshot still lists", () => {
    const remembered = worktree("/a-feature");
    expect(
      restoreSelection(
        snapshot("/a", [a, b], 0, ["/a-feature"]),
        remembered,
        none,
      ),
    ).toBe(remembered);
  });

  it("falls back to the newest commit when a remembered worktree is gone", () => {
    expect(
      restoreSelection(
        snapshot("/a", [a, b], 0, ["/a-other"]),
        worktree("/a-feature"),
        none,
      ),
    ).toEqual(commit(a));
    expect(restoreSelection(snapshot("/a"), worktree("/a-feature"), none)).toBe(
      null,
    );
  });

  it("keeps a worktree while its status is unread or changed, and leaves it once it is clean", () => {
    const listed = snapshot("/a", [a, b], 0, ["/a-feature"]);
    const remembered = worktree("/a-feature");
    const root = rootSchema.parse("/a-feature");
    const head = listed.worktrees[0]!.head;
    const status = (entries: StatusEntry[]): ChangesByWorktree =>
      new Map([[root, { kind: "ready", status: { root, head, entries } }]]);
    const failed: ChangesByWorktree = new Map([
      [root, { kind: "error", error: { kind: "timedOut", message: "Slow." } }],
    ]);
    expect(restoreSelection(listed, remembered, none)).toBe(remembered);
    expect(
      restoreSelection(
        listed,
        remembered,
        status([{ kind: "untracked", path: "new.txt" }]),
      ),
    ).toBe(remembered);
    expect(restoreSelection(listed, remembered, failed)).toBe(remembered);
    expect(restoreSelection(listed, remembered, status([]))).toEqual(commit(a));
  });
});
