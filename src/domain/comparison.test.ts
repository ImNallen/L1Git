import { describe, expect, it } from "vitest";
import {
  compareListed,
  compareRows,
  compared,
  comparedRowId,
  swapEnds,
} from "./comparison";
import { worktreeRowId } from "./graph";
import { oidSchema, rootSchema } from "./repository";
import type { Commit } from "./repository";
import type { Selection } from "./selection";
import type { HistoryRow } from "./worktree";

const root = rootSchema.parse("/work/l1-demo");
const newer = oidSchema.parse("b".repeat(40));
const older = oidSchema.parse("a".repeat(40));
const commit = (oid: typeof newer): Selection => ({ kind: "commit", oid });
const worktree: Selection = { kind: "worktree", root };
const row = (oid: typeof newer): HistoryRow => ({
  kind: "commit",
  id: oid,
  parents: [],
  commit: {
    oid,
    parents: [],
    subject: oid,
    author: "Ada",
    email: "ada@example.test",
    timestamp: 0,
  } satisfies Commit,
});
const rows = [row(newer), row(older)];

describe("comparing history rows", () => {
  it("makes the older commit the base, whichever row was selected first", () => {
    expect(compareRows(rows, root, commit(newer), commit(older))).toEqual({
      root,
      anchor: commit(newer),
      base: older,
      target: commit(newer),
    });
    expect(compareRows(rows, root, commit(older), commit(newer))).toEqual({
      root,
      anchor: commit(older),
      base: older,
      target: commit(newer),
    });
  });

  it("always targets the worktree and refuses two worktrees", () => {
    for (const [anchor, other] of [
      [commit(older), worktree],
      [worktree, commit(older)],
    ] as const)
      expect(compareRows(rows, root, anchor, other)).toMatchObject({
        anchor,
        base: older,
        target: worktree,
      });
    expect(compareRows(rows, root, worktree, worktree)).toBeNull();
  });

  it("compares a commit with itself and marks no second row", () => {
    const self = compareRows(rows, root, commit(newer), commit(newer));
    expect(self).toMatchObject({ base: newer, target: commit(newer) });
    expect(self && comparedRowId(self)).toBeNull();
  });

  it("marks the row that is not the selection", () => {
    const pair = compareRows(rows, root, commit(older), commit(newer));
    expect(pair && comparedRowId(pair)).toBe(newer);
    const working = compareRows(rows, root, commit(older), worktree);
    expect(working && comparedRowId(working)).toBe(worktreeRowId(root));
  });

  it("swaps two commits but not a worktree target", () => {
    const pair = compareRows(rows, root, commit(older), commit(newer));
    if (!pair) throw new Error("expected a comparison");
    const swapped = swapEnds(pair);
    expect(swapped && compared(swapped)).toEqual({
      base: { kind: "commit", oid: newer },
      target: commit(older),
    });
    expect(swapped?.anchor).toEqual(commit(older));
    const working = compareRows(rows, root, commit(older), worktree);
    expect(working && swapEnds(working)).toBeNull();
  });

  it("drops a comparison whose end left the snapshot", () => {
    const pair = compareRows(rows, root, commit(older), commit(newer));
    if (!pair) throw new Error("expected a comparison");
    const commits = rows.flatMap((entry) =>
      entry.kind === "commit" ? [entry.commit] : [],
    );
    expect(compareListed({ commits, worktrees: [] }, pair)).toBe(true);
    expect(
      compareListed({ commits: commits.slice(0, 1), worktrees: [] }, pair),
    ).toBe(false);
  });
});
