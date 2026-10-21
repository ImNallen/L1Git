import { describe, expect, it } from "vitest";
import { buildGraph } from "./graph";
import {
  historyAction,
  navigate,
  landingFromHidden,
  nextRow,
  revealRow,
} from "./navigation";
import type { HistoryKey, Move, Trail } from "./navigation";
import { oidSchema } from "./repository";
import type { Oid } from "./repository";

const oid = (hex: string) => oidSchema.parse(hex.repeat(40));
const merge = oid("a");
const f2 = oid("b");
const t1 = oid("c");
const f1 = oid("d");
const t0 = oid("e");
const root = oid("f");

const history = [
  { id: merge, parents: [t1, f2] },
  { id: f2, parents: [f1] },
  { id: t1, parents: [t0] },
  { id: f1, parents: [t0] },
  { id: t0, parents: [root] },
  { id: root, parents: [] },
];
const graph = buildGraph(history).rows;
const move = (selected: Oid | null, to: Move) =>
  nextRow(history, graph, selected, to);

describe("history navigation", () => {
  it("moves one row at a time and stops at both ends", () => {
    expect(move(merge, "down")).toBe(f2);
    expect(move(f2, "down")).toBe(t1);
    expect(move(t1, "up")).toBe(f2);
    expect(move(merge, "up")).toBe(merge);
    expect(move(root, "down")).toBe(root);
  });

  it("jumps to the first and last loaded commits", () => {
    expect(move(t1, "first")).toBe(merge);
    expect(move(t1, "last")).toBe(root);
  });

  it("starts from the newest commit without a loaded selection", () => {
    expect(move(null, "down")).toBe(merge);
    expect(move(oid("9"), "child")).toBe(merge);
    expect(move(null, "last")).toBe(root);
    expect(nextRow([], new Map(), null, "down")).toBeNull();
  });

  it("follows the first parent across the merge instead of the next row", () => {
    expect(move(merge, "parent")).toBe(t1);
    expect(move(t1, "child")).toBe(merge);
    expect(move(f2, "parent")).toBe(f1);
    expect(move(f1, "child")).toBe(f2);
  });

  it("stays on a feature tip whose only child merged it as a second parent", () => {
    expect(move(f2, "child")).toBe(f2);
  });

  it("continues up the fork point's own lane rather than the nearer feature", () => {
    expect(move(t0, "child")).toBe(t1);
  });

  it("stays when the first parent is not loaded or there is none", () => {
    const partial = history.slice(0, 5);
    expect(nextRow(partial, buildGraph(partial).rows, t0, "parent")).toBe(t0);
    expect(move(root, "parent")).toBe(root);
  });

  it("falls back to the nearest child when a merge opened the fork point's line", () => {
    const top = oid("1");
    const side = oid("2");
    const trunk = oid("3");
    const base = oid("4");
    const bottom = oid("5");
    const commits = [
      { id: top, parents: [trunk, base] },
      { id: side, parents: [base] },
      { id: trunk, parents: [bottom] },
      { id: base, parents: [bottom] },
      { id: bottom, parents: [] },
    ];
    expect(nextRow(commits, buildGraph(commits).rows, base, "child")).toBe(
      side,
    );
  });

  it("follows the fork point's line up after a lane to its left closes", () => {
    const top = oid("1");
    const child = oid("2");
    const closed = oid("3");
    const side = oid("4");
    const fork = oid("5");
    const commits = [
      { id: top, parents: [closed] },
      { id: child, parents: [fork] },
      { id: closed, parents: [] },
      { id: side, parents: [fork] },
      { id: fork, parents: [] },
    ];
    const rows = buildGraph(commits).rows;
    expect([child, side, fork].map((commit) => rows.get(commit)?.lane)).toEqual(
      [1, 1, 0],
    );
    expect(nextRow(commits, rows, fork, "child")).toBe(child);
  });

  it("passes a merge's straight second-parent edge to reach the child that opened the line", () => {
    const x = oid("1");
    const a = oid("2");
    const b = oid("3");
    const q = oid("4");
    const z = oid("5");
    const t = oid("6");
    const p = oid("7");
    const commits = [
      { id: x, parents: [z] },
      { id: a, parents: [t] },
      { id: b, parents: [t] },
      { id: q, parents: [p] },
      { id: z, parents: [p, t] },
      { id: t, parents: [] },
      { id: p, parents: [] },
    ];
    expect(nextRow(commits, buildGraph(commits).rows, t, "child")).toBe(a);
  });

  it("takes the straight edge into the fork point over the lane that curves into it", () => {
    const merge = oid("1");
    const feature2 = oid("2");
    const feature1 = oid("3");
    const trunk = oid("4");
    const fork = oid("5");
    const commits = [
      { id: merge, parents: [trunk, feature2] },
      { id: feature2, parents: [feature1] },
      { id: feature1, parents: [fork] },
      { id: trunk, parents: [fork] },
      { id: fork, parents: [] },
    ];
    const rows = buildGraph(commits).rows;
    expect(rows.get(trunk)?.parents).toEqual([{ oid: fork, from: 0, to: 0 }]);
    expect(rows.get(trunk)?.continuations).toEqual([
      { oid: fork, from: 1, to: 0 },
    ]);
    expect(nextRow(commits, rows, fork, "child")).toBe(trunk);
  });
});

describe("first-parent trail", () => {
  const feature2 = oid("2");
  const feature1 = oid("3");
  const trunk = oid("4");
  const fork = oid("5");
  const commits = [
    { id: oid("1"), parents: [trunk, feature2] },
    { id: feature2, parents: [feature1] },
    { id: feature1, parents: [fork] },
    { id: trunk, parents: [fork] },
    { id: fork, parents: [] },
  ];
  const rows = buildGraph(commits).rows;
  const go = (selected: Oid, to: Move, trail: Trail | null) =>
    navigate(commits, rows, selected, to, trail);

  it("retraces Shift+Down with Shift+Up past the fork point", () => {
    const one = go(feature2, "parent", null);
    expect(one).toEqual({
      id: feature1,
      trail: { end: feature1, passed: [feature2] },
    });
    const two = go(feature1, "parent", one.trail);
    expect(two).toEqual({
      id: fork,
      trail: { end: fork, passed: [feature2, feature1] },
    });
    const three = go(fork, "child", two.trail);
    expect(three).toEqual({
      id: feature1,
      trail: { end: feature1, passed: [feature2] },
    });
    expect(go(feature1, "child", three.trail)).toEqual({
      id: feature2,
      trail: null,
    });
  });

  it("follows the line once the selection has left the trail", () => {
    const trail = { end: feature1, passed: [feature2] };
    expect(go(fork, "child", trail)).toEqual({ id: trunk, trail: null });
    expect(go(fork, "child", null)).toEqual({ id: trunk, trail: null });
  });

  it("ignores a trail step that an amend removed from the loaded history", () => {
    const amended = oid("6");
    const reloaded = [
      { id: amended, parents: [feature1] },
      { id: feature1, parents: [fork] },
      { id: fork, parents: [] },
    ];
    expect(
      navigate(reloaded, buildGraph(reloaded).rows, feature1, "child", {
        end: feature1,
        passed: [feature2],
      }),
    ).toEqual({ id: amended, trail: null });
  });

  it("ignores a trail step whose first parent is no longer the selection", () => {
    expect(go(fork, "child", { end: fork, passed: [feature2] })).toEqual({
      id: trunk,
      trail: null,
    });
  });

  it("drops the trail on any other move", () => {
    expect(go(fork, "up", { end: fork, passed: [feature1] })).toEqual({
      id: trunk,
      trail: null,
    });
  });

  it("keeps the trail when Shift+Down has no parent to move to", () => {
    const trail = { end: fork, passed: [feature1] };
    expect(go(fork, "parent", trail)).toEqual({ id: fork, trail });
  });
});

describe("first-parent moves on generated graphs", () => {
  function random(seed: number) {
    let state = seed;
    return () => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state / 2147483648;
    };
  }
  function generate(seed: number) {
    const next = random(seed);
    const size = 6 + Math.floor(next() * 20);
    const ids = Array.from({ length: size }, (_, index) =>
      oidSchema.parse(index.toString(16).padStart(40, "0")),
    );
    return ids.map((id, index) => {
      const older = ids.slice(index + 1);
      const parents: Oid[] = [];
      const count = older.length === 0 ? 0 : next() < 0.2 ? 2 : 1;
      while (parents.length < Math.min(count, older.length)) {
        const parent = older[Math.floor(next() * Math.min(older.length, 5))];
        if (parent !== undefined && !parents.includes(parent))
          parents.push(parent);
      }
      return { id, parents };
    });
  }

  it("moves up only to a first-parent child and retraces every Shift+Down", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const commits = generate(seed);
      const rows = buildGraph(commits).rows;
      commits.forEach((commit, index) => {
        const up = nextRow(commits, rows, commit.id, "child");
        const children = commits
          .slice(0, index)
          .filter((child) => child.parents.at(0) === commit.id);
        expect(
          children.length === 0
            ? up === commit.id
            : children.some((child) => child.id === up),
        ).toBe(true);
        const down = navigate(commits, rows, commit.id, "parent", null);
        if (down.id === commit.id) return;
        expect(
          navigate(commits, rows, down.id ?? commit.id, "child", down.trail).id,
        ).toBe(commit.id);
      });
    }
  });
});

describe("history keys", () => {
  const press = (key: string, modifiers: Partial<HistoryKey> = {}) =>
    historyAction({
      key,
      shiftKey: false,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      ...modifiers,
    });

  it("maps arrows, J and K, Home and End, and Enter", () => {
    expect(press("ArrowDown")).toBe("down");
    expect(press("j")).toBe("down");
    expect(press("ArrowUp")).toBe("up");
    expect(press("k")).toBe("up");
    expect(press("Home")).toBe("first");
    expect(press("End")).toBe("last");
    expect(press("Enter")).toBe("open");
  });

  it("jumps with Cmd or Ctrl and follows the branch with Shift", () => {
    expect(press("ArrowUp", { metaKey: true })).toBe("first");
    expect(press("ArrowDown", { ctrlKey: true })).toBe("last");
    expect(press("Home", { ctrlKey: true })).toBe("first");
    expect(press("End", { metaKey: true })).toBe("last");
    expect(press("ArrowUp", { shiftKey: true })).toBe("child");
    expect(press("ArrowDown", { shiftKey: true })).toBe("parent");
    expect(press("K", { shiftKey: true })).toBe("child");
    expect(press("J", { shiftKey: true })).toBe("parent");
  });

  it("reads J and K typed with Caps Lock as j and k", () => {
    expect(press("J")).toBe("down");
    expect(press("K")).toBe("up");
  });

  it("cancels with Escape", () => {
    expect(press("Escape")).toBe("cancel");
  });

  it("opens the column menu with Shift+F10 or the context menu key", () => {
    expect(press("F10", { shiftKey: true })).toBe("columns");
    expect(press("ContextMenu")).toBe("columns");
    expect(press("F10")).toBeNull();
  });

  it("ignores other keys and combinations", () => {
    expect(press("j", { metaKey: true })).toBeNull();
    expect(press("Enter", { shiftKey: true })).toBeNull();
    expect(press("ArrowDown", { altKey: true })).toBeNull();
    expect(press("ArrowDown", { metaKey: true, shiftKey: true })).toBeNull();
    expect(press("Tab")).toBeNull();
  });
});

describe("revealing a row", () => {
  it("scrolls as little as possible to show the whole row", () => {
    expect(revealRow(5, 36, 0, 360)).toBe(0);
    expect(revealRow(10, 36, 0, 360)).toBe(36);
    expect(revealRow(2, 36, 180, 360)).toBe(72);
    expect(revealRow(9, 36, 10, 360)).toBe(10);
  });
});

describe("moving from a selection a rule hides", () => {
  const loaded = history.map((row) => ({ oid: row.id }));
  const shown = new Set([merge, t1, t0, root]);

  it("lands on the nearest shown row below for Down and Shift+Down", () => {
    expect(landingFromHidden(loaded, shown, f2, "down")).toBe(t1);
    expect(landingFromHidden(loaded, shown, f1, "parent")).toBe(t0);
  });

  it("lands on the nearest shown row above for Up and Shift+Up", () => {
    expect(landingFromHidden(loaded, shown, f1, "up")).toBe(t1);
    expect(landingFromHidden(loaded, shown, f2, "child")).toBe(merge);
  });

  it("falls back to the other side at either end", () => {
    const oldest = new Set([merge]);
    expect(landingFromHidden(loaded, oldest, f2, "down")).toBe(merge);
    const newest = new Set([root]);
    expect(landingFromHidden(loaded, newest, f2, "up")).toBe(root);
  });

  it("leaves shown, unloaded, and whole-history moves to navigate", () => {
    expect(landingFromHidden(loaded, shown, t1, "down")).toBeNull();
    expect(landingFromHidden(loaded, shown, oid("9"), "down")).toBeNull();
    expect(landingFromHidden(loaded, shown, f2, "last")).toBeNull();
  });
});
