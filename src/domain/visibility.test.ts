import { describe, expect, it } from "vitest";
import { oidSchema, refSchema } from "./repository";
import type { Branch, FullRef, RepositorySnapshot } from "./repository";
import {
  NO_RULE,
  branchVisibility,
  pruneRule,
  revealBranch,
  toggleRule,
  visibleCommits,
} from "./visibility";
import type { VisibilityRule } from "./visibility";

const oid = (letter: string) => oidSchema.parse(letter.repeat(40));
const ref = (name: string) => refSchema.parse(`refs/heads/${name}`);
const base = oid("a");
const theme = oid("b");
const history1 = oid("c");
const history2 = oid("d");
const merge = oid("e");
const squashed = oid("f");
const squash = oid("1");
const inspector = oid("2");

const commits = [
  { oid: inspector, parents: [merge] },
  { oid: squash, parents: [merge] },
  { oid: squashed, parents: [merge] },
  { oid: merge, parents: [theme, history2] },
  { oid: history2, parents: [history1] },
  { oid: theme, parents: [base] },
  { oid: history1, parents: [base] },
  { oid: base, parents: [] },
];

const branch = (name: string, tip: (typeof commits)[number]["oid"]) =>
  ({
    kind: "local",
    reference: ref(name),
    name,
    oid: tip,
    upstream: null,
  }) satisfies Branch;

const refs: Pick<
  RepositorySnapshot,
  "head" | "branches" | "tags" | "worktrees"
> = {
  head: { kind: "attached", reference: ref("main"), oid: squash },
  branches: [
    branch("main", squash),
    branch("feat/history", history2),
    branch("feat/squashed", squashed),
    branch("feat/inspector", inspector),
  ],
  tags: [],
  worktrees: [],
};

const rule = (kind: "hide" | "solo", ...names: string[]): VisibilityRule => ({
  kind,
  refs: new Set<FullRef>(names.map(ref)),
});

const shown = (visibility: VisibilityRule) =>
  visibleCommits(commits, refs, visibility).map((commit) => commit.oid);

describe("branch visibility", () => {
  it("shows every commit, as the same array, under an empty rule", () => {
    expect(visibleCommits(commits, refs, NO_RULE)).toBe(commits);
  });

  it("drops only the commits unique to a hidden branch", () => {
    expect(shown(rule("hide", "feat/squashed"))).toEqual([
      inspector,
      squash,
      merge,
      history2,
      theme,
      history1,
      base,
    ]);
  });

  it("drops nothing when another branch shares a hidden branch's commits", () => {
    expect(shown(rule("hide", "feat/history"))).toEqual(
      commits.map((commit) => commit.oid),
    );
  });

  it("keeps the ancestry of two soloed branches and HEAD", () => {
    expect(
      shown({
        kind: "solo",
        refs: new Set([ref("feat/history"), ref("feat/inspector")]),
      }),
    ).toEqual([inspector, squash, merge, history2, theme, history1, base]);
  });

  it("keeps HEAD's ancestry when soloing a branch HEAD is not on", () => {
    const detached = {
      ...refs,
      head: { kind: "detached" as const, oid: history1 },
    };
    expect(
      visibleCommits(commits, detached, rule("solo", "feat/history")).map(
        (commit) => commit.oid,
      ),
    ).toEqual([history2, history1, base]);
  });

  it("keeps tags and other worktrees as tips while hiding", () => {
    const pinned = {
      ...refs,
      tags: [
        {
          reference: refSchema.parse("refs/tags/v1"),
          name: "v1",
          oid: squashed,
        },
      ],
    };
    expect(visibleCommits(commits, pinned, rule("hide", "feat/squashed"))).toBe(
      commits,
    );
  });

  it("shows everything when no soloed branch exists any more", () => {
    expect(visibleCommits(commits, refs, rule("solo", "gone"))).toBe(commits);
  });

  it("toggles a branch in a rule and clears the rule when it empties", () => {
    const hidden = toggleRule(NO_RULE, "hide", ref("feat/history"));
    expect(branchVisibility(hidden, ref("feat/history"))).toBe("hidden");
    expect(toggleRule(hidden, "hide", ref("feat/history"))).toBe(NO_RULE);
    const soloed = toggleRule(hidden, "solo", ref("main"));
    expect(soloed).toEqual(rule("solo", "main"));
    expect(branchVisibility(soloed, ref("feat/history"))).toBe("shown");
    expect(branchVisibility(soloed, ref("main"))).toBe("soloed");
  });

  it("reveals a branch by unhiding it or soloing it too", () => {
    expect(
      revealBranch(rule("hide", "main", "feat/history"), ref("main")),
    ).toEqual(rule("hide", "feat/history"));
    expect(revealBranch(rule("solo", "main"), ref("feat/history"))).toEqual(
      rule("solo", "main", "feat/history"),
    );
  });

  it("drops refs that no longer exist and keeps an unchanged rule as is", () => {
    const branches = refs.branches;
    const live = rule("hide", "main", "feat/history");
    expect(pruneRule(live, branches)).toBe(live);
    expect(pruneRule(rule("hide", "main", "gone"), branches)).toEqual(
      rule("hide", "main"),
    );
    expect(pruneRule(rule("solo", "gone", "also-gone"), branches)).toBe(
      NO_RULE,
    );
    expect(pruneRule(NO_RULE, branches)).toBe(NO_RULE);
  });
});
