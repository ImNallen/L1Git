import { describe, expect, it } from "vitest";
import {
  attentionRows,
  overviewSchema,
  readyAdvances,
  repositoryRank,
} from "./overview";

const a = "a".repeat(40);
const b = "b".repeat(40);
const c = "c".repeat(40);
const d = "d".repeat(40);

function row(
  name: string,
  role: "default" | "mainline" | "other",
  state: Record<string, unknown>,
  checkedOutAt: string | null = null,
) {
  return {
    reference: `refs/heads/${name}`,
    name,
    oid: a,
    role,
    checkedOutAt,
    state,
  };
}

const overview = overviewSchema.parse({
  root: "/code/app",
  commonDir: "/code/app/.git",
  name: "app",
  branches: [
    row("develop", "mainline", {
      kind: "behind",
      upstream: "refs/remotes/origin/develop",
      target: b,
      behind: 2,
      blocker: { kind: "dirty", worktree: "/code/app-develop" },
    }),
    row("feat/ahead", "other", {
      kind: "ahead",
      upstream: "refs/remotes/origin/feat/ahead",
      ahead: 1,
    }),
    row("feat/done", "other", {
      kind: "upToDate",
      upstream: "refs/remotes/origin/feat/done",
    }),
    row("feat/gone", "other", {
      kind: "gone",
      upstream: "refs/remotes/origin/feat/gone",
    }),
    row("feat/hidden", "other", {
      kind: "behind",
      upstream: "refs/remotes/origin/feat/hidden",
      target: c,
      behind: 1,
      blocker: {
        kind: "unverified",
        message:
          "Git did not finish checking whether this branch is checked out.",
      },
    }),
    row("feat/local", "other", { kind: "untracked" }),
    row("feat/split", "other", {
      kind: "diverged",
      upstream: "refs/remotes/origin/feat/split",
      ahead: 1,
      behind: 3,
    }),
    row("feat/stale", "other", {
      kind: "behind",
      upstream: "refs/remotes/origin/feat/stale",
      target: c,
      behind: 1,
      blocker: null,
    }),
    row(
      "main",
      "default",
      {
        kind: "behind",
        upstream: "refs/remotes/origin/main",
        target: d,
        behind: 4,
        blocker: null,
      },
      "/code/app",
    ),
    row("trunk", "mainline", {
      kind: "upToDate",
      upstream: "refs/remotes/origin/trunk",
    }),
  ],
  fetch: {
    at: 1_780_000_000,
    changed: true,
    coalesced: false,
    remotes: [
      { remote: "origin", outcome: { kind: "fetched" } },
      {
        remote: "backup",
        outcome: {
          kind: "failed",
          failure: "auth",
          message: "Permission denied (publickey).",
        },
      },
    ],
  },
  observedAt: 1_780_000_001,
});

describe("launch overview", () => {
  it("offers exactly the unblocked behind pairs Rust reported", () => {
    expect(readyAdvances(overview)).toEqual([
      { reference: "refs/heads/feat/stale", from: a, to: c },
      { reference: "refs/heads/main", from: a, to: d },
    ]);
  });

  it("rejects rows that would let the UI move a non-branch ref", () => {
    const remoteRef = overviewSchema.safeParse({
      ...overview,
      branches: [{ ...overview.branches[0], reference: "refs/remotes/x/y" }],
    });
    expect(remoteRef.error?.issues[0]?.path).toEqual([
      "branches",
      0,
      "reference",
    ]);
  });

  it("shows default and mainline rows first, then rows that need attention", () => {
    const { rows, hiddenUpToDate } = attentionRows(overview);
    expect(rows.map((branch) => branch.name)).toEqual([
      "main",
      "develop",
      "trunk",
      "feat/hidden",
      "feat/stale",
      "feat/split",
      "feat/gone",
      "feat/ahead",
    ]);
    expect(hiddenUpToDate).toBe(1);
  });

  it("ranks repositories by how urgently they need attention", () => {
    const only = (...names: string[]) => ({
      ...overview,
      branches: overview.branches.filter((branch) =>
        names.includes(branch.name),
      ),
    });
    expect(repositoryRank(only("main", "feat/done"), true)).toBe(0);
    expect(repositoryRank(only("trunk", "feat/split"), true)).toBe(1);
    expect(repositoryRank(only("trunk", "feat/split"), false)).toBe(2);
    expect(repositoryRank(only("trunk", "feat/stale"), false)).toBe(2);
    expect(
      repositoryRank(only("trunk", "feat/done", "feat/local"), false),
    ).toBe(3);
  });
});
