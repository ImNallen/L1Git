import { describe, expect, it } from "vitest";
import { landingFromHidden } from "./navigation";
import { oidSchema, refSchema, rootSchema } from "./repository";
import type { Worktree } from "./repository";
import { historyPlace, sameSelection, stableSelection } from "./selection";
import type { Selection } from "./selection";

const commit = (letter: string): Selection => ({
  kind: "commit",
  oid: oidSchema.parse(letter.repeat(40)),
});
const worktree = (root: string): Selection => ({
  kind: "worktree",
  root: rootSchema.parse(root),
});

describe("sameSelection", () => {
  it("matches commits by oid and worktrees by root", () => {
    expect(sameSelection(commit("a"), commit("a"))).toBe(true);
    expect(sameSelection(commit("a"), commit("b"))).toBe(false);
    expect(sameSelection(worktree("/w"), worktree("/w"))).toBe(true);
    expect(sameSelection(worktree("/w"), worktree("/x"))).toBe(false);
  });

  it("never matches a commit with a worktree", () => {
    expect(sameSelection(commit("a"), worktree("/w"))).toBe(false);
    expect(sameSelection(worktree("/w"), commit("a"))).toBe(false);
  });

  it("matches nothing selected only with nothing selected", () => {
    expect(sameSelection(null, null)).toBe(true);
    expect(sameSelection(null, commit("a"))).toBe(false);
    expect(sameSelection(worktree("/w"), null)).toBe(false);
  });
});

describe("a selection's place in the history", () => {
  const tree = (root: string, head: Worktree["head"]): Worktree => ({
    root: rootSchema.parse(root),
    name: root.slice(1),
    head,
    current: false,
  });
  const hiddenHead = commit("b");
  const worktrees = [
    tree("/w", {
      kind: "detached",
      oid: oidSchema.parse("b".repeat(40)),
    }),
    tree("/new", {
      kind: "unborn",
      reference: refSchema.parse("refs/heads/main"),
    }),
  ];
  const loaded = ["a", "b", "c"].map((letter) => ({
    oid: oidSchema.parse(letter.repeat(40)),
  }));
  const shown = new Set([loaded[0]!.oid, loaded[2]!.oid]);

  it("is a commit's own ID and a worktree's HEAD", () => {
    expect(historyPlace(hiddenHead, worktrees)).toBe("b".repeat(40));
    expect(historyPlace(worktree("/w"), worktrees)).toBe("b".repeat(40));
    expect(historyPlace(worktree("/new"), worktrees)).toBeNull();
    expect(historyPlace(worktree("/gone"), worktrees)).toBeNull();
    expect(historyPlace(null, worktrees)).toBeNull();
  });

  it("lands a worktree whose row a rule hides next to its HEAD, like a hidden commit", () => {
    for (const selection of [hiddenHead, worktree("/w")]) {
      const place = historyPlace(selection, worktrees);
      expect(landingFromHidden(loaded, shown, place, "down")).toBe(
        loaded[2]!.oid,
      );
      expect(landingFromHidden(loaded, shown, place, "up")).toBe(
        loaded[0]!.oid,
      );
    }
  });
});

describe("stableSelection", () => {
  it("keeps the previous object when the next selection is the same", () => {
    const previous = commit("a");
    expect(stableSelection(previous, commit("a"))).toBe(previous);
    const tree = worktree("/w");
    expect(stableSelection(tree, worktree("/w"))).toBe(tree);
  });

  it("takes the next object when the selection changes", () => {
    const next = commit("b");
    expect(stableSelection(commit("a"), next)).toBe(next);
    expect(stableSelection(null, next)).toBe(next);
    const tree = worktree("/w");
    expect(stableSelection(commit("a"), tree)).toBe(tree);
  });
});
