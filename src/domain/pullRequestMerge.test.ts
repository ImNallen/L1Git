import { describe, expect, it } from "vitest";
import type { BranchStatus } from "./overview";
import type { PullRequest } from "./pullRequest";
import { pullRequestSchema } from "./pullRequest";
import type { PullCheckout } from "./pullRequestCheckout";
import {
  commitTexts,
  localDelete,
  mergeChoices,
  mergeLabel,
  remoteDelete,
} from "./pullRequestMerge";
import { oidSchema } from "./repository";

const oid = (digit: string) => oidSchema.parse(digit.repeat(40));
const page = <T>(items: T[], total = items.length) => ({ items, total });
const at = "2026-11-24T10:00:00Z";

function pull(fields: Partial<PullRequest> = {}): PullRequest {
  return pullRequestSchema.parse({
    id: "PR_127",
    repositoryId: "R_1",
    number: 127,
    title: "fix(sync): notice an unfinished fetch",
    body: "A fetch that the remote drops half way used to end without a word.",
    state: { kind: "open", draft: false },
    author: "adam",
    viewerIsAuthor: true,
    viewerPermission: "write",
    base: "main",
    baseOid: oid("b"),
    labels: page([]),
    additions: 1,
    deletions: 2,
    changedFiles: 5,
    createdAt: at,
    updatedAt: at,
    head: {
      branch: "fix/sync-stall",
      oid: oid("1"),
      repository: { owner: "l1", repo: "l1-git" },
      crossRepository: false,
      maintainerCanModify: false,
      ref: { id: "REF_1", othersOpen: 0, viewerCanDelete: true },
    },
    reviewers: [{ login: "jonas", state: "approved" }],
    checks: page([]),
    commits: page(
      ["a", "c", "d", "e"].map((digit) => ({
        oid: oid(digit),
        headline: `Commit ${digit}`,
        by: "adam",
        at,
      })),
    ),
    timeline: page([]),
    threads: page([]),
    mergeable: "mergeable",
    mergeState: "clean",
    decision: null,
    merge: {
      allowed: { merge: true, squash: true, rebase: false },
      preferred: "squash",
      deletesBranch: false,
    },
    pending: { kind: "none" },
    ...fields,
  });
}

describe("merge methods", () => {
  it("turns off what the repository turns off, and says so", () => {
    const { methods } = mergeChoices(pull(), null);
    expect(methods).toEqual([
      {
        method: "squash",
        label: "Squash and merge",
        note: "One commit on main.",
        off: false,
      },
      {
        method: "merge",
        label: "Create a merge commit",
        note: "Keeps all 4 commits and adds a merge commit.",
        off: false,
      },
      {
        method: "rebase",
        label: "Rebase and merge",
        note: "Turned off in this repository's settings on GitHub.",
        off: true,
      },
    ]);
  });

  it("says one commit as one", () => {
    const one = pull({ commits: page([pull().commits.items[0]!]) });
    expect(mergeChoices(one, null).methods.map(({ note }) => note)).toEqual([
      "One commit on main.",
      "Keeps the commit and adds a merge commit.",
      "Turned off in this repository's settings on GitHub.",
    ]);
  });

  it("preselects the last used in L1 Git, else the repository's", () => {
    expect(mergeChoices(pull(), null).chosen).toBe("squash");
    const last = mergeChoices(pull(), "merge");
    expect(last.chosen).toBe("merge");
    expect(last.methods[1]?.note).toBe(
      "Keeps all 4 commits and adds a merge commit. Last used in L1 Git.",
    );
    expect(
      mergeChoices(pull(), "rebase").chosen,
      "not one the repository turned off since",
    ).toBe("squash");
    const preferredOff = pull({
      merge: {
        allowed: { merge: true, squash: false, rebase: false },
        preferred: "squash",
        deletesBranch: false,
      },
    });
    expect(mergeChoices(preferredOff, null).chosen).toBe("merge");
  });

  it("labels the button by the method", () => {
    expect(mergeLabel("squash", false)).toBe("Squash and merge");
    expect(mergeLabel("squash", true)).toBe("Squash and merge anyway");
    expect(mergeLabel("merge", false)).toBe("Merge");
    expect(mergeLabel("rebase", true)).toBe("Rebase and merge anyway");
  });

  it("starts the commit message as GitHub would", () => {
    expect(commitTexts(pull(), "squash")).toEqual({
      headline: "fix(sync): notice an unfinished fetch (#127)",
      body: "A fetch that the remote drops half way used to end without a word.",
    });
    expect(commitTexts(pull(), "merge")).toEqual({
      headline: "Merge pull request #127 from l1/fix/sync-stall",
      body: "fix(sync): notice an unfinished fetch",
    });
    expect(commitTexts(pull(), "rebase"), "rebase writes no commit").toBe(null);
  });
});

describe("deleting the branch on GitHub", () => {
  const head = pull().head;
  it.each<[string, Partial<PullRequest>, unknown]>([
    [
      "when nothing else uses it",
      {},
      { kind: "offer", note: "No other pull request uses it." },
    ],
    [
      "checked, when the repository deletes it after a merge",
      { merge: { ...pull().merge, deletesBranch: true } },
      {
        kind: "github",
        note: "GitHub deletes it after the merge, by this repository's settings.",
      },
    ],
    [
      "not while another open pull request uses it",
      { head: { ...head, ref: { ...head.ref!, othersOpen: 2 } } },
      { kind: "off", note: "2 other open pull requests use it." },
    ],
    [
      "not a fork's branch",
      {
        head: {
          ...head,
          crossRepository: true,
          repository: { owner: "sara", repo: "l1-git" },
        },
      },
      { kind: "off", note: "It's in sara/l1-git, a fork." },
    ],
    [
      "not when GitHub won't let the viewer",
      { head: { ...head, ref: { ...head.ref!, viewerCanDelete: false } } },
      { kind: "off", note: "GitHub doesn't let you delete it." },
    ],
    [
      "nothing when it is gone already",
      { head: { ...head, ref: null } },
      { kind: "none" },
    ],
  ])("%s", (_, fields, expected) => {
    expect(remoteDelete(pull(fields))).toEqual(expected);
  });
});

describe("deleting the local branch", () => {
  const plan = {
    folder: "/src/.worktrees/l1git-pr-127",
    pushes: {
      kind: "toPullRequest",
      remote: "origin",
      destination: "refs/heads/fix/sync-stall",
      addsRemote: false,
    },
  };
  const copy = (fields: object) => ({ ...fields }) as PullCheckout;
  const branch = (
    name: string,
    state: BranchStatus["state"],
    checkedOutAt: string | null = null,
  ) =>
    ({
      reference: `refs/heads/${name}`,
      name,
      oid: oid("1"),
      role: "other",
      checkedOutAt,
      state,
    }) as BranchStatus;
  const upToDate = {
    kind: "upToDate",
    upstream: "refs/remotes/origin/fix/sync-stall",
  } as BranchStatus["state"];

  it("offers L1 Git's copy, pr/<number>, when it holds nothing else", () => {
    expect(
      localDelete(
        copy({
          kind: "parked",
          branch: "refs/heads/pr/127",
          tip: oid("1"),
          relation: { kind: "behind", commits: 2 },
          plan,
        }),
        [],
      ),
    ).toEqual({
      kind: "offer",
      name: "pr/127",
      branch: { reference: "refs/heads/pr/127", oid: oid("1") },
    });
    expect(
      localDelete(
        copy({
          kind: "parked",
          branch: "refs/heads/pr/127",
          tip: oid("1"),
          relation: { kind: "ahead", commits: 1 },
          plan,
        }),
        [],
      ),
    ).toEqual({
      kind: "off",
      name: "pr/127",
      note: "It has commits that aren't in the pull request.",
    });
  });

  it("keeps a branch it can't compare with the pull request", () => {
    expect(
      localDelete(
        copy({
          kind: "parked",
          branch: "refs/heads/pr/127",
          tip: oid("1"),
          relation: { kind: "unfetched" },
          plan,
        }),
        [],
      ),
    ).toEqual({
      kind: "off",
      name: "pr/127",
      note: "L1 Git hasn't fetched the pull request's newest commits, so it can't tell whether this branch has commits that aren't in it.",
    });
    const absent = copy({ kind: "absent", branch: "refs/heads/pr/127", plan });
    expect(
      localDelete(absent, [
        branch("fix/sync-stall", {
          kind: "gone",
          upstream: "refs/remotes/origin/fix/sync-stall",
        } as BranchStatus["state"]),
      ]),
    ).toEqual({
      kind: "off",
      name: "fix/sync-stall",
      note: "Its branch on GitHub is gone, so L1 Git can't tell whether it has commits that aren't on GitHub.",
    });
  });

  it("keeps a copy checked out in a worktree", () => {
    expect(
      localDelete(
        copy({
          kind: "ready",
          branch: "refs/heads/pr/127",
          tip: oid("1"),
          relation: { kind: "upToDate" },
          worktree: {
            root: "/src/.worktrees/l1git-pr-127",
            name: "l1git-pr-127",
            main: false,
            changes: { kind: "clean" },
          },
        }),
        [],
      ),
    ).toEqual({
      kind: "off",
      name: "pr/127",
      note: "It's checked out in l1git-pr-127.",
    });
  });

  it("offers your own branch that tracks the head", () => {
    const absent = copy({ kind: "absent", branch: "refs/heads/pr/127", plan });
    expect(
      localDelete(absent, [
        branch("main", { kind: "untracked" }),
        branch("fix/sync-stall", upToDate),
      ]),
    ).toEqual({
      kind: "offer",
      name: "fix/sync-stall",
      branch: { reference: "refs/heads/fix/sync-stall", oid: oid("1") },
    });
    expect(
      localDelete(absent, [branch("fix/sync-stall", upToDate, "/src/l1-git")]),
    ).toEqual({
      kind: "off",
      name: "fix/sync-stall",
      note: "It's checked out in l1-git.",
    });
    expect(
      localDelete(absent, [
        branch("fix/sync-stall", {
          kind: "ahead",
          upstream: "refs/remotes/origin/fix/sync-stall",
          ahead: 1,
        } as BranchStatus["state"]),
      ]),
    ).toMatchObject({
      kind: "off",
      note: "It has commits that aren't on GitHub.",
    });
    expect(
      localDelete(absent, [
        branch("other", {
          kind: "upToDate",
          upstream: "refs/remotes/upstream/fix/sync-stall",
        } as BranchStatus["state"]),
      ]),
      "a branch of the same name on another remote isn't it",
    ).toEqual({ kind: "none" });
  });

  it("offers nothing when nothing tracks it, or it can't tell", () => {
    expect(localDelete(null, [])).toEqual({ kind: "none" });
    expect(
      localDelete(
        copy({
          kind: "absent",
          branch: "refs/heads/pr/127",
          plan: { ...plan, pushes: { kind: "nowhere", why: "noRemote" } },
        }),
        [branch("fix/sync-stall", upToDate)],
      ),
    ).toEqual({ kind: "none" });
  });
});
