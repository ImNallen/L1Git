import { describe, expect, it } from "vitest";
import { buildGraph } from "./graph";
import { historyAction, nextRow, revealRow } from "./navigation";
import type { HistoryKey, Move } from "./navigation";
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
  { oid: merge, parents: [t1, f2] },
  { oid: f2, parents: [f1] },
  { oid: t1, parents: [t0] },
  { oid: f1, parents: [t0] },
  { oid: t0, parents: [root] },
  { oid: root, parents: [] },
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
      { oid: top, parents: [trunk, base] },
      { oid: side, parents: [base] },
      { oid: trunk, parents: [bottom] },
      { oid: base, parents: [bottom] },
      { oid: bottom, parents: [] },
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
      { oid: top, parents: [closed] },
      { oid: child, parents: [fork] },
      { oid: closed, parents: [] },
      { oid: side, parents: [fork] },
      { oid: fork, parents: [] },
    ];
    const rows = buildGraph(commits).rows;
    expect([child, side, fork].map((commit) => rows.get(commit)?.lane)).toEqual(
      [1, 1, 0],
    );
    expect(nextRow(commits, rows, fork, "child")).toBe(child);
  });

  it("takes the straight edge into the fork point over the lane that curves into it", () => {
    const merge = oid("1");
    const feature2 = oid("2");
    const feature1 = oid("3");
    const trunk = oid("4");
    const fork = oid("5");
    const commits = [
      { oid: merge, parents: [trunk, feature2] },
      { oid: feature2, parents: [feature1] },
      { oid: feature1, parents: [fork] },
      { oid: trunk, parents: [fork] },
      { oid: fork, parents: [] },
    ];
    const rows = buildGraph(commits).rows;
    expect(rows.get(trunk)?.parents).toEqual([{ oid: fork, from: 0, to: 0 }]);
    expect(rows.get(trunk)?.continuations).toEqual([
      { oid: fork, from: 1, to: 0 },
    ]);
    expect(nextRow(commits, rows, fork, "child")).toBe(trunk);
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
    expect(press("ArrowUp", { shiftKey: true })).toBe("child");
    expect(press("ArrowDown", { shiftKey: true })).toBe("parent");
  });

  it("ignores other keys and combinations", () => {
    expect(press("J", { shiftKey: true })).toBeNull();
    expect(press("j", { metaKey: true })).toBeNull();
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
