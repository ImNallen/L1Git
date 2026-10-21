import { describe, expect, it } from "vitest";
import { buildGraph, worktreeRowId } from "./graph";
import type { GraphRow, RowId } from "./graph";
import { oidSchema, rootSchema } from "./repository";
import type { Oid, RepositoryRoot, Worktree } from "./repository";
import { historyRows } from "./worktree";
import type { ChangesByWorktree } from "./worktree";

const a = oidSchema.parse("a".repeat(40));
const b = oidSchema.parse("b".repeat(40));
const c = oidSchema.parse("c".repeat(40));
const d = oidSchema.parse("d".repeat(40));
const e = oidSchema.parse("e".repeat(40));

describe("history graph", () => {
  it("draws both actual merge parents and rejoins their shared ancestor", () => {
    const graph = buildGraph([
      { id: a, parents: [b, c] },
      { id: b, parents: [d] },
      { id: c, parents: [d] },
      { id: d, parents: [] },
    ]);
    expect(graph.lanes).toBe(2);
    expect(graph.rows.get(a)).toEqual({
      id: a,
      lane: 0,
      incoming: false,
      continuations: [],
      parents: [
        { oid: b, from: 0, to: 0 },
        { oid: c, from: 0, to: 1 },
      ],
    });
    expect(graph.rows.get(b)?.continuations).toEqual([
      { oid: c, from: 1, to: 1 },
    ]);
    expect(graph.rows.get(c)).toEqual({
      id: c,
      lane: 1,
      incoming: true,
      continuations: [{ oid: d, from: 0, to: 0 }],
      parents: [{ oid: d, from: 1, to: 0 }],
    });
    expect(graph.rows.get(d)?.parents).toEqual([]);
  });

  it("keeps unrelated roots separate and retains a parent beyond the loaded boundary", () => {
    const graph = buildGraph([
      { id: a, parents: [b] },
      { id: c, parents: [] },
      { id: b, parents: [e] },
    ]);
    expect(graph.rows.get(c)).toEqual({
      id: c,
      lane: 1,
      incoming: false,
      continuations: [{ oid: b, from: 0, to: 0 }],
      parents: [],
    });
    expect(graph.rows.get(b)?.parents).toEqual([{ oid: e, from: 0, to: 0 }]);
    expect(graph.rows.has(e)).toBe(false);
    expect(buildGraph([])).toEqual({ rows: new Map(), lanes: 1 });
  });

  it("runs a squash commit's lane down into the tip of the branch it merged", () => {
    const graph = buildGraph(
      [
        { id: a, parents: [b] },
        { id: c, parents: [d] },
        { id: b, parents: [d] },
        { id: d, parents: [] },
      ],
      [{ tip: c, commit: a }],
    );
    expect(graph.lanes).toBe(2);
    expect(graph.rows.get(a)).toEqual({
      id: a,
      lane: 0,
      incoming: false,
      continuations: [],
      parents: [
        { oid: b, from: 0, to: 0 },
        { oid: c, from: 0, to: 1 },
      ],
    });
    expect(graph.rows.get(c)).toEqual({
      id: c,
      lane: 1,
      incoming: true,
      continuations: [{ oid: b, from: 0, to: 0 }],
      parents: [{ oid: d, from: 1, to: 1 }],
    });
    expect(graph.rows.get(b)).toEqual({
      id: b,
      lane: 0,
      incoming: true,
      continuations: [{ oid: d, from: 1, to: 0 }],
      parents: [{ oid: d, from: 0, to: 0 }],
    });
  });
});

describe("worktree rows in the graph", () => {
  const commit = (oid: Oid, parents: Oid[]) => ({
    oid,
    parents,
    subject: "",
    author: "A",
    email: "a@example.com",
    timestamp: 0,
  });
  const worktree = (path: string, oid: Oid): Worktree => ({
    root: rootSchema.parse(path),
    name: path.slice(1),
    head: { kind: "detached", oid },
    current: false,
  });
  const dirty = (worktrees: Worktree[]): ChangesByWorktree =>
    new Map(
      worktrees.map(({ root, head }) => [
        root,
        {
          kind: "ready",
          status: {
            root,
            head,
            entries: [{ kind: "untracked", path: "new.txt" }],
          },
        },
      ]),
    );
  const plain = (commits: { oid: Oid; parents: Oid[] }[]) =>
    buildGraph(commits.map(({ oid, parents }) => ({ id: oid, parents }))).rows;
  const lanesOf = (rows: Map<RowId, GraphRow>, ids: RowId[]) =>
    ids.map((id) => rows.get(id)?.lane);
  const rowOf = (root: RepositoryRoot) => worktreeRowId(root);

  it("puts a worktree on a branch tip in the tip's lane without moving a commit", () => {
    const commits = [
      commit(a, [b, c]),
      commit(b, [d]),
      commit(c, [d]),
      commit(d, []),
    ];
    const one = worktree("/one", a);
    const rows = historyRows(commits, [one], dirty([one]));
    const w = rowOf(one.root);
    expect(rows.map((row) => row.id)).toEqual([w, a, b, c, d]);
    const graph = buildGraph(rows);
    const before = plain(commits);
    expect(graph.rows.get(w)).toEqual({
      id: w,
      lane: 0,
      incoming: false,
      continuations: [],
      parents: [{ oid: a, from: 0, to: 0 }],
    });
    expect(graph.rows.get(a)).toEqual({ ...before.get(a), incoming: true });
    for (const oid of [b, c, d])
      expect(graph.rows.get(oid)).toEqual(before.get(oid));
    expect(graph.lanes).toBe(2);
  });

  it("gives worktrees on two tips their tips' lanes", () => {
    const commits = [commit(a, [c]), commit(b, [c]), commit(c, [])];
    const one = worktree("/one", a);
    const two = worktree("/two", b);
    const rows = historyRows(commits, [two, one], dirty([one, two]));
    const [w1, w2] = [rowOf(one.root), rowOf(two.root)];
    expect(rows.map((row) => row.id)).toEqual([w1, a, w2, b, c]);
    const graph = buildGraph(rows);
    expect(lanesOf(graph.rows, [w1, a, w2, b, c])).toEqual([0, 0, 1, 1, 0]);
    expect(lanesOf(plain(commits), [a, b, c])).toEqual([0, 1, 0]);
    expect(graph.rows.get(w2)).toEqual({
      id: w2,
      lane: 1,
      incoming: false,
      continuations: [{ oid: c, from: 0, to: 0 }],
      parents: [{ oid: b, from: 1, to: 1 }],
    });
    expect(graph.rows.get(b)).toEqual({
      id: b,
      lane: 1,
      incoming: true,
      continuations: [{ oid: c, from: 0, to: 0 }],
      parents: [{ oid: c, from: 1, to: 0 }],
    });
    expect(graph.lanes).toBe(2);
  });

  it("opens a lane for a worktree on a commit in the middle of the history", () => {
    const commits = [commit(a, [b]), commit(b, [c]), commit(c, [])];
    const middle = worktree("/middle", b);
    const rows = historyRows(commits, [middle], dirty([middle]));
    const w = rowOf(middle.root);
    expect(rows.map((row) => row.id)).toEqual([a, w, b, c]);
    const graph = buildGraph(rows);
    expect(graph.rows.get(w)).toEqual({
      id: w,
      lane: 1,
      incoming: false,
      continuations: [{ oid: b, from: 0, to: 0 }],
      parents: [{ oid: b, from: 1, to: 0 }],
    });
    const before = plain(commits);
    for (const oid of [a, b, c])
      expect(graph.rows.get(oid)).toEqual(before.get(oid));
    expect(graph.lanes).toBe(2);
  });

  it("gives no row to a clean worktree or one whose HEAD is not shown", () => {
    const commits = [commit(a, [b]), commit(b, [])];
    const clean = worktree("/clean", a);
    const elsewhere = worktree("/elsewhere", e);
    const changes: ChangesByWorktree = new Map([
      ...dirty([elsewhere]),
      [
        clean.root,
        {
          kind: "ready",
          status: { root: clean.root, head: clean.head, entries: [] },
        },
      ],
    ]);
    expect(
      historyRows(commits, [clean, elsewhere], changes).map((row) => row.id),
    ).toEqual([a, b]);
  });
});
