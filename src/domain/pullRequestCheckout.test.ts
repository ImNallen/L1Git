import { describe, expect, it } from "vitest";
import { pull } from "../test/pullRequests";
import { pullCheckoutSchema, pullHead } from "./pullRequestCheckout";

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

  it("says a fork takes your pushes when its author allows edits or it is yours", () => {
    const maja = { owner: "maja", repo: "pin" };
    const fork = (maintainerCanModify: boolean, viewerIsAuthor: boolean) =>
      pullHead({
        ...head({
          crossRepository: true,
          repository: maja,
          maintainerCanModify,
        }),
        viewerIsAuthor,
      }).from;
    expect(fork(true, false)).toEqual({
      kind: "fork",
      repository: maja,
      edits: true,
    });
    expect(fork(false, true)).toEqual({
      kind: "fork",
      repository: maja,
      edits: true,
    });
    expect(fork(false, false)).toEqual({
      kind: "fork",
      repository: maja,
      edits: false,
    });
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
