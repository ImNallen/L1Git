import { describe, expect, it } from "vitest";
import { oidSchema, rootSchema } from "./repository";
import { sameSelection, stableSelection } from "./selection";
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
