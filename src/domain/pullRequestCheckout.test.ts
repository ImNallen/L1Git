import { describe, expect, it } from "vitest";
import { pull } from "../test/pullRequests";
import type { PullRequest } from "./pullRequest";
import {
  pullCheckoutSchema,
  pullHead,
  pullKeySchema,
} from "./pullRequestCheckout";

const oid = "1".repeat(40);
const head = (fields: Partial<ReturnType<typeof pull>["head"]>) =>
  pull(7, { head: { ...pull(7).head, branch: "feat/replay-ui", ...fields } });

describe("pullHead", () => {
  it("names the head branch in full and keeps the commit GitHub reported", () => {
    expect(pullHead(head({}))).toEqual({
      reference: "refs/heads/feat/replay-ui",
      oid,
      from: { kind: "same" },
    });
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
          trouble: null,
        },
      },
    ])
      expect(pullCheckoutSchema.parse(checkout)).toEqual(checkout);
  });

  it("reads each reason pushes go nowhere", () => {
    for (const why of ["noEdits", "forkGone", "noRemote"] as const)
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
