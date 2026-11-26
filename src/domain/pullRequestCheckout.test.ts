import { describe, expect, it } from "vitest";
import { pull } from "../test/pullRequests";
import type { PullRequest } from "./pullRequest";
import {
  barWords,
  moveOf,
  pullCheckoutSchema,
  pullHead,
  pullKeySchema,
  pushesWords,
  removable,
  replaceWords,
  underHome,
} from "./pullRequestCheckout";
import type { HeldCheckout, Plan } from "./pullRequestCheckout";
import type { Oid } from "./repository";

const oid = "1".repeat(40);
const head = (fields: Partial<ReturnType<typeof pull>["head"]>) =>
  pull(7, { head: { ...pull(7).head, branch: "feat/replay-ui", ...fields } });

describe("pullHead", () => {
  it("names the head branch in full and keeps the commit GitHub reported", () => {
    expect(pullHead(head({}))).toEqual({
      reference: "refs/heads/feat/replay-ui",
      oid,
      from: { kind: "same", edits: true },
    });
  });

  it("says the base repository takes your pushes when you can write to it, or, with no role GitHub names, when you wrote the pull request", () => {
    const edits = (
      viewerIsAuthor: boolean,
      viewerPermission: PullRequest["viewerPermission"],
    ) => {
      const { from } = pullHead({
        ...head({}),
        viewerIsAuthor,
        viewerPermission,
      });
      return from.kind === "same" && from.edits;
    };
    for (const [viewerIsAuthor, permission, expected] of [
      [false, "admin", true],
      [false, "maintain", true],
      [false, "write", true],
      [false, "triage", false],
      [false, "read", false],
      [false, "unknown", false],
      [true, "read", false],
      [true, "write", true],
      [true, "unknown", true],
    ] as const)
      expect(
        edits(viewerIsAuthor, permission),
        `${viewerIsAuthor} ${permission}`,
      ).toBe(expected);
  });

  it("says a fork takes your pushes when it is yours, or its author allows edits and you can push to the base", () => {
    const maja = { owner: "maja", repo: "pin" };
    const edits = (
      maintainerCanModify: boolean,
      viewerIsAuthor: boolean,
      viewerPermission: PullRequest["viewerPermission"],
    ) => {
      const { from } = pullHead({
        ...head({
          crossRepository: true,
          repository: maja,
          maintainerCanModify,
        }),
        viewerIsAuthor,
        viewerPermission,
      });
      return from.kind === "fork" && from.edits;
    };
    for (const [maintainerCanModify, viewerIsAuthor, permission, expected] of [
      [true, false, "admin", true],
      [true, false, "maintain", true],
      [true, false, "write", true],
      [true, false, "triage", false],
      [true, false, "read", false],
      [true, false, "unknown", false],
      [false, false, "admin", false],
      [false, true, "read", true],
      [true, true, "unknown", true],
    ] as const)
      expect(
        edits(maintainerCanModify, viewerIsAuthor, permission),
        `${maintainerCanModify} ${viewerIsAuthor} ${permission}`,
      ).toBe(expected);
  });

  it("says a fork is gone when GitHub no longer names its repository", () => {
    expect(
      pullHead(
        head({
          crossRepository: true,
          repository: null,
          maintainerCanModify: true,
        }),
      ).from,
    ).toEqual({ kind: "gone" });
  });
});

describe("pullKeySchema", () => {
  it("takes the pull request numbers the core takes", () => {
    const key = (number: number) =>
      pullKeySchema.safeParse({ github: { owner: "o", repo: "r" }, number })
        .success;
    expect([0, 1, 2 ** 32 - 1, 2 ** 32].map(key)).toEqual([
      false,
      true,
      true,
      false,
    ]);
  });
});

describe("pullCheckoutSchema", () => {
  const plan = {
    folder: "/u/src/.worktrees/l1git-pr-7",
    pushes: { kind: "nowhere", why: "noEdits" },
  };

  it("reads each state the core answers", () => {
    for (const checkout of [
      { kind: "absent", branch: "refs/heads/pr/7", plan },
      {
        kind: "parked",
        branch: "refs/heads/pr/7",
        tip: oid,
        relation: { kind: "diverged", ahead: 2, behind: 1 },
        plan,
      },
      {
        kind: "ready",
        branch: "refs/heads/pr/7",
        tip: oid,
        relation: { kind: "behind", commits: 3 },
        worktree: {
          root: plan.folder,
          name: "l1git-pr-7",
          main: false,
          changes: { kind: "inProgress", operation: "rebase" },
        },
      },
    ])
      expect(pullCheckoutSchema.parse(checkout)).toEqual(checkout);
  });

  it("reads each reason pushes go nowhere", () => {
    for (const why of ["noEdits", "forkGone", "noRemote", "readOnly"] as const)
      expect(
        pullCheckoutSchema.parse({
          kind: "absent",
          branch: "refs/heads/pr/7",
          plan: { ...plan, pushes: { kind: "nowhere", why } },
        }),
      ).toMatchObject({ plan: { pushes: { why } } });
  });

  it("refuses a relation or a push it does not know", () => {
    expect(
      pullCheckoutSchema.safeParse({
        kind: "parked",
        branch: "refs/heads/pr/7",
        tip: oid,
        relation: { kind: "rewritten", commits: 1 },
        plan,
      }).success,
    ).toBe(false);
    expect(
      pullCheckoutSchema.safeParse({
        kind: "absent",
        branch: "refs/heads/pr/7",
        plan: { ...plan, pushes: { kind: "nowhere", why: "closed" } },
      }).success,
    ).toBe(false);
  });
});

const tip = "9c2e1b4".padEnd(40, "0") as Oid;
const branch = "refs/heads/pr/128";
const root = "/u/src/.worktrees/l1git-pr-128";
const ready = (
  relation: HeldCheckout["relation"],
  changes: Extract<HeldCheckout, { kind: "ready" }>["worktree"]["changes"] = {
    kind: "clean",
  },
  main = false,
) =>
  pullCheckoutSchema.parse({
    kind: "ready",
    branch,
    tip,
    relation,
    worktree: { root, name: "l1git-pr-128", main, changes, trouble: null },
  }) as HeldCheckout;
const parked = (relation: HeldCheckout["relation"]) =>
  pullCheckoutSchema.parse({
    kind: "parked",
    branch,
    tip,
    relation,
    plan: { folder: root, pushes: { kind: "nowhere", why: "noEdits" } },
  }) as HeldCheckout;

describe("barWords", () => {
  it.each([
    [{ kind: "upToDate" }, "at 9c2e1b4, up to date"],
    [
      { kind: "behind", commits: 1 },
      "at 9c2e1b4, 1 commit behind the pull request",
    ],
    [
      { kind: "behind", commits: 3 },
      "at 9c2e1b4, 3 commits behind the pull request",
    ],
    [
      { kind: "ahead", commits: 2 },
      "at 9c2e1b4, 2 commits ahead of the pull request",
    ],
    [
      { kind: "diverged", ahead: 1, behind: 3 },
      "at 9c2e1b4, 1 commit ahead of the pull request and 3 behind it",
    ],
    [
      { kind: "unfetched" },
      "at 9c2e1b4, the pull request has new commits on GitHub",
    ],
  ] as const)("says where a worktree stands: %j", (relation, state) => {
    expect(barWords(ready(relation), null)).toEqual({
      lead: "Checked out locally in",
      place: root,
      state,
    });
  });

  it.each([
    [{ kind: "uncommitted" }, "with uncommitted changes"],
    [{ kind: "inProgress", operation: "rebase" }, "with a rebase in progress"],
    [{ kind: "missing" }, "but its folder is missing"],
  ] as const)("notes what the worktree holds: %j", (changes, noted) => {
    expect(barWords(ready({ kind: "upToDate" }, changes), null).state).toBe(
      `at 9c2e1b4, up to date, ${noted}`,
    );
  });

  it("writes the folder with ~ when it is under the home folder", () => {
    expect(barWords(ready({ kind: "upToDate" }), "/u").place).toBe(
      "~/src/.worktrees/l1git-pr-128",
    );
  });

  it("names the branch it kept when no worktree has it", () => {
    expect(barWords(parked({ kind: "ahead", commits: 2 }), null)).toEqual({
      lead: "Kept locally as",
      place: "pr/128",
      state: "at 9c2e1b4, 2 commits ahead of the pull request, not checked out",
    });
  });
});

describe("moveOf and removable", () => {
  it.each([
    [{ kind: "upToDate" }, null],
    [{ kind: "behind", commits: 2 }, { kind: "update" }],
    [{ kind: "unfetched" }, { kind: "update" }],
    [
      { kind: "ahead", commits: 2 },
      { kind: "replace", leaving: 2 },
    ],
    [
      { kind: "diverged", ahead: 4, behind: 1 },
      { kind: "replace", leaving: 4 },
    ],
  ] as const)("moves a branch by how it stands: %j", (relation, move) => {
    expect(moveOf(ready(relation))).toEqual(move);
    expect(moveOf(parked(relation))).toEqual(move);
  });

  it("moves nothing in a worktree whose folder is gone", () => {
    expect(
      moveOf(ready({ kind: "behind", commits: 1 }, { kind: "missing" })),
    ).toBeNull();
  });

  it("removes only a linked worktree", () => {
    const upToDate = { kind: "upToDate" } as const;
    expect(removable(ready(upToDate))).toBe(true);
    expect(removable(ready(upToDate, { kind: "missing" }))).toBe(true);
    expect(removable(ready(upToDate, { kind: "clean" }, true))).toBe(false);
    expect(removable(parked(upToDate))).toBe(false);
  });
});

describe("replaceWords", () => {
  const head = "1".repeat(40) as Oid;
  it("names how many commits leave the branch, and what happens to changes", () => {
    expect(replaceWords(ready({ kind: "ahead", commits: 2 }), 2, head)).toEqual(
      {
        title: "Replace pr/128 with the pull request?",
        body: "pr/128 moves to the pull request's head, 1111111. The 2 commits on pr/128 that aren't in the pull request leave the branch, and L1 Git can't undo that. Uncommitted changes stay, and if the pull request changes the same files, nothing moves.",
      },
    );
    expect(
      replaceWords(parked({ kind: "diverged", ahead: 1, behind: 1 }), 1, head)
        .body,
    ).toBe(
      "pr/128 moves to the pull request's head, 1111111. The commit on pr/128 that isn't in the pull request leaves the branch, and L1 Git can't undo that.",
    );
  });
});

describe("pushesWords", () => {
  const destination = "refs/heads/feat/replay-ui";
  const maja = { owner: "maja", repo: "l1git" };
  const of = (crossRepository: boolean, maintainerCanModify = false) =>
    head({
      crossRepository,
      repository: crossRepository ? maja : { owner: "octo", repo: "l1git" },
      maintainerCanModify,
    }).head;
  const stays = "so commits you make there stay local.";
  it.each([
    [
      {
        kind: "toPullRequest",
        remote: "origin",
        destination,
        addsRemote: false,
      },
      of(false),
      "Tracks origin/feat/replay-ui. Pushing from there updates the pull request.",
    ],
    [
      { kind: "nowhere", why: "readOnly" },
      of(false),
      "Pulling from there brings the author's pushes. You can't push to this repository, so GitHub refuses a push from there.",
    ],
    [
      { kind: "nowhere", why: "noRemote" },
      of(false),
      "No remote of this clone is the pull request's repository on GitHub, so L1 Git can't fetch the pull request.",
    ],
    [
      { kind: "toPullRequest", remote: "maja", destination, addsRemote: true },
      of(true, true),
      "Tracks maja/feat/replay-ui, on a remote L1 Git adds for maja's fork. Pushing from there updates the pull request.",
    ],
    [
      { kind: "nowhere", why: "noEdits" },
      of(true),
      `The author doesn't allow edits from maintainers, ${stays}`,
    ],
    [
      { kind: "nowhere", why: "noEdits" },
      of(true, true),
      `The author allows edits from maintainers, but you can't push to this repository, ${stays}`,
    ],
    [
      { kind: "nowhere", why: "forkGone" },
      { ...of(true), repository: null },
      `The fork this pull request came from is gone, ${stays}`,
    ],
  ] as const)("says where pushes go: %j", (pushes, from, said) => {
    expect(pushesWords(pushes as Plan["pushes"], from)).toBe(said);
  });
});

describe("underHome", () => {
  it.each([
    [
      "/Users/ada/src/.worktrees/l1git-pr-128",
      "/Users/ada",
      "~/src/.worktrees/l1git-pr-128",
    ],
    ["/Users/ada", "/Users/ada/", "~"],
    ["/Users/adam/src", "/Users/ada", "/Users/adam/src"],
    ["/srv/l1git-pr-128", "/Users/ada", "/srv/l1git-pr-128"],
    ["/Users/ada/src", null, "/Users/ada/src"],
    ["/srv/x", "/", "/srv/x"],
    ["C:\\Users\\ada\\src", "C:\\Users\\ada", "~\\src"],
  ])("writes %s under %s as %s", (path, home, written) => {
    expect(underHome(path, home)).toBe(written);
  });
});
