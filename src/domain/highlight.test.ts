import { describe, expect, it } from "vitest";
import { buildGraph } from "./graph";
import { highlightBranch, trunkTips } from "./highlight";
import { branchStatusSchema } from "./overview";
import { branchSchema, oidSchema } from "./repository";
import type { Oid, Squash } from "./repository";

const oid = (hex: string) => oidSchema.parse(hex.repeat(40));
const squash = oid("a");
const merge = oid("b");
const f2 = oid("c");
const f1 = oid("d");
const t2 = oid("e");
const t1 = oid("f");
const t0 = oid("0");

const highlight = (
  commits: { oid: Oid; parents: Oid[] }[],
  squashes: Squash[],
  tip: Oid,
  trunk: Oid[],
) => highlightBranch(commits, buildGraph(commits, squashes).rows, tip, trunk);

// Feature f1..f2 forked at t0 while trunk moved on to t1 and t2, then
// squash-merged as `squash`.
const squashed = [
  { oid: squash, parents: [t2] },
  { oid: f2, parents: [f1] },
  { oid: t2, parents: [t1] },
  { oid: f1, parents: [t0] },
  { oid: t1, parents: [t0] },
  { oid: t0, parents: [] },
];
const squashes = [{ tip: f2, commit: squash }];

describe("branch highlight", () => {
  it("lights a squash-merged feature, its fork point, and the squash commit", () => {
    expect(highlight(squashed, squashes, f2, [squash]).commits).toEqual(
      new Set([f2, f1, t0, squash]),
    );
  });

  it("lights the trunk's first-parent chain and not the feature it squashed", () => {
    const { commits, rows } = highlight(squashed, squashes, squash, [squash]);
    expect(commits).toEqual(new Set([squash, t2, t1, t0]));
    expect(rows.get(squash)?.parents).toEqual([true, false]);
    expect(rows.get(f2)).toEqual({
      incoming: false,
      continuations: [true],
      parents: [false],
    });
  });

  it("lights a real merge commit as merged into the feature", () => {
    const commits = [
      { oid: merge, parents: [t1, f2] },
      { oid: f2, parents: [f1] },
      { oid: t1, parents: [t0] },
      { oid: f1, parents: [t0] },
      { oid: t0, parents: [] },
    ];
    const { commits: lit, rows } = highlight(commits, [], f2, [merge]);
    expect(lit).toEqual(new Set([f2, f1, t0, merge]));
    expect(rows.get(merge)?.parents).toEqual([false, true]);
    expect(rows.get(t1)?.parents).toEqual([false]);
  });

  it("lights a continuation only on lanes that carry a lit edge", () => {
    const { rows } = highlight(squashed, squashes, f2, [squash]);
    expect(Object.fromEntries(rows)).toEqual({
      [squash]: { incoming: false, continuations: [], parents: [false, true] },
      [f2]: { incoming: true, continuations: [false], parents: [true] },
      [t2]: { incoming: false, continuations: [true], parents: [false] },
      [f1]: { incoming: true, continuations: [false], parents: [true] },
      [t1]: { incoming: false, continuations: [true], parents: [false] },
      [t0]: { incoming: true, continuations: [], parents: [] },
    });
  });
});

describe("trunk tips", () => {
  const branch = (kind: "local" | "remote", name: string, tip: Oid) =>
    branchSchema.parse(
      kind === "local"
        ? {
            kind,
            reference: `refs/heads/${name}`,
            name,
            oid: tip,
            upstream: `refs/remotes/origin/${name}`,
          }
        : {
            kind,
            reference: `refs/remotes/origin/${name}`,
            name: `origin/${name}`,
            oid: tip,
            remote: "origin",
          },
    );
  const branches = [
    branch("local", "main", t0),
    branch("local", "develop", t1),
    branch("remote", "develop", t2),
  ];

  it("uses the default branch and its upstream", () => {
    const develop = branchStatusSchema.parse({
      reference: "refs/heads/develop",
      name: "develop",
      oid: t1,
      role: "default",
      checkedOutAt: null,
      state: { kind: "untracked" },
    });
    expect(trunkTips(branches, [develop])).toEqual([t1, t2]);
  });

  it("falls back to a local main without a default branch", () => {
    expect(trunkTips(branches, [])).toEqual([t0]);
  });
});
