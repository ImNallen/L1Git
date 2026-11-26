import { describe, expect, it } from "vitest";
import type { BranchStatus } from "./overview";
import type { Check, PullRequest } from "./pullRequest";
import { pullRequestSchema } from "./pullRequest";
import type { PullCheckout } from "./pullRequestCheckout";
import {
  commitTexts,
  localDelete,
  mergeChoices,
  mergeLabel,
  remoteDelete,
  shownBox,
} from "./pullRequestMerge";
import type { LocalDelete, MergeProgress } from "./pullRequestMerge";
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

const check = (
  name: string,
  state: Check["state"],
  required = false,
): Check => ({
  name,
  state,
  required,
  startedAt: null,
  completedAt: null,
  url: null,
});
const passed = (count: number) =>
  Array.from({ length: count }, (_, index) => check(`ok ${index}`, "passed"));
const idle: MergeProgress = { kind: "idle" };
const none: LocalDelete = { kind: "none" };
const tracked: LocalDelete = {
  kind: "offer",
  name: "pr/127",
  branch: { reference: "refs/heads/pr/127", oid: oid("1") },
} as LocalDelete;
const ago = () => "just now";

describe("the merge box's fourteen states", () => {
  it.each<
    [
      string,
      Partial<PullRequest>,
      MergeProgress,
      LocalDelete,
      { kind: string; title: string; text?: string; action: unknown },
    ]
  >([
    [
      "just merged, with the local branch still here",
      {
        state: { kind: "merged", at },
        timeline: page([
          { id: "M1", kind: "merged", oid: oid("4"), by: "adam", at },
        ]),
      },
      idle,
      tracked,
      {
        kind: "merged",
        title: "Merged into main",
        text: "Merged as 4444444 just now. Your local branch pr/127 is still here.",
        action: { kind: "deleteLocal" },
      },
    ],
    [
      "merging",
      {},
      { kind: "sending", method: "squash" },
      none,
      {
        kind: "merging",
        title: "Merging into main…",
        text: "This takes a few seconds. You can leave this page.",
        action: { kind: "merging" },
      },
    ],
    [
      "GitHub refused the merge because the head moved",
      { head: { ...pull().head, oid: oid("9") } },
      {
        kind: "refused",
        message: "GitHub didn't do it: Head branch was modified.",
        expectedHead: oid("1"),
      },
      none,
      {
        kind: "failed",
        title: "GitHub didn't merge this",
        text: "New commits arrived. Review them, then merge.",
        action: { kind: "retry" },
      },
    ],
    [
      "a draft",
      { state: { kind: "open", draft: true } },
      idle,
      none,
      { kind: "draft", title: "Draft", action: { kind: "openOnGitHub" } },
    ],
    [
      "read access only",
      { viewerPermission: "read" },
      idle,
      none,
      {
        kind: "readOnly",
        title: "You can't merge here",
        text: "Your role in this repository is Read. Someone with Write access can merge.",
        action: { kind: "none" },
      },
    ],
    [
      "conflicts",
      { mergeable: "conflicting", mergeState: "dirty" },
      idle,
      none,
      {
        kind: "conflicts",
        title: "Conflicts with main",
        action: { kind: "openOnGitHub" },
      },
    ],
    [
      "open, changes requested",
      {
        mergeState: "blocked",
        reviewers: [{ login: "sara", state: "changesRequested" }],
      },
      idle,
      none,
      {
        kind: "changesRequested",
        title: "Changes requested",
        action: { kind: "openOnGitHub" },
      },
    ],
    [
      "open, approvals missing",
      {
        mergeState: "blocked",
        reviewers: [{ login: "sara", state: "requested" }],
      },
      idle,
      none,
      {
        kind: "reviewRequired",
        title: "Review required",
        action: { kind: "openOnGitHub" },
      },
    ],
    [
      "a required check fails",
      {
        mergeState: "blocked",
        checks: page([...passed(2), check("windows", "failed", true)]),
      },
      idle,
      none,
      {
        kind: "requiredFailing",
        title: "1 required check is failing",
        action: { kind: "openOnGitHub" },
      },
    ],
    [
      "out of date, and the branch rule says it can't be",
      { mergeState: "behind" },
      idle,
      none,
      {
        kind: "behind",
        title: "Behind main",
        action: { kind: "openOnGitHub" },
      },
    ],
    [
      "merge when ready is on, which L1 Git doesn't read: required checks run",
      {
        mergeState: "blocked",
        checks: page([...passed(9), check("slow", "running", true)]),
      },
      idle,
      none,
      {
        kind: "running",
        title: "9 of 10 checks done",
        text: "Merging waits for 1 required check.",
        action: { kind: "none" },
      },
    ],
    [
      "checks failing, not required",
      {
        mergeState: "unstable",
        checks: page([
          ...passed(12),
          check("a", "failed"),
          check("b", "failed"),
        ]),
      },
      idle,
      none,
      {
        kind: "failing",
        title: "2 checks are failing",
        text: "None of them is required on main, so this can still merge.",
        action: { kind: "merge", anyway: true },
      },
    ],
    [
      "checks running, not required",
      {
        mergeState: "unstable",
        checks: page([...passed(9), ...Array(5).fill(check("x", "running"))]),
      },
      idle,
      none,
      {
        kind: "running",
        title: "9 of 14 checks done",
        action: { kind: "merge", anyway: false },
      },
    ],
    [
      "ready",
      { checks: page(passed(14)) },
      idle,
      none,
      {
        kind: "ready",
        title: "Ready to merge",
        text: "Approved by jonas, and all 14 checks passed.",
        action: { kind: "merge", anyway: false },
      },
    ],
  ])("%s", (_, fields, progress, local, expected) => {
    expect(shownBox(pull(fields), "adam", ago, progress, local)).toMatchObject(
      expected,
    );
  });
});

describe("what the merge box offers", () => {
  const actionOf = (
    fields: Partial<PullRequest>,
    progress: MergeProgress = idle,
    local: LocalDelete = none,
  ) => shownBox(pull(fields), "adam", ago, progress, local).action;

  it("offers a merge only to a role that can merge", () => {
    for (const viewerPermission of ["write", "maintain", "admin"] as const)
      expect(actionOf({ viewerPermission })).toEqual({
        kind: "merge",
        anyway: false,
      });
    expect(actionOf({ viewerPermission: "triage" })).toEqual({ kind: "none" });
    expect(
      shownBox(pull({ viewerPermission: "unknown" }), "adam", ago, idle, none),
      "an unknown role is no claim that you can't",
    ).toMatchObject({ kind: "ready", action: { kind: "none" } });
  });

  it("merges anyway past a check it can't see", () => {
    expect(
      actionOf({ mergeState: "unstable", checks: page(passed(3), 140) }),
    ).toEqual({ kind: "merge", anyway: true });
  });

  it("offers nothing while GitHub can't tell, or nothing is allowed", () => {
    expect(actionOf({ mergeable: "unknown", mergeState: "unknown" })).toEqual({
      kind: "none",
    });
    expect(
      actionOf({
        merge: {
          allowed: { merge: false, squash: false, rebase: false },
          preferred: "merge",
          deletesBranch: false,
        },
      }),
    ).toEqual({ kind: "none" });
    expect(actionOf({ state: { kind: "closed", at } })).toEqual({
      kind: "none",
    });
  });

  it("says plainly that a merge with no answer may have landed", () => {
    expect(
      shownBox(pull(), "adam", ago, { kind: "unknown", kept: true }, none),
    ).toMatchObject({
      kind: "checking",
      title: "L1 Git can't tell yet whether this merged",
      action: { kind: "openOnGitHub" },
    });
    expect(
      shownBox(pull(), "adam", ago, { kind: "unknown", kept: false }, none)
        .action,
      "with nothing kept to look for, the user moves on",
    ).toEqual({ kind: "retry" });
  });

  it("shows the read over a write it settled", () => {
    const merged = pull({ state: { kind: "merged", at } });
    expect(
      shownBox(merged, "adam", ago, { kind: "unknown", kept: true }, none),
    ).toMatchObject({ kind: "merged", action: { kind: "none" } });
    expect(
      shownBox(pull(), "adam", ago, { kind: "done", commit: oid("4") }, none),
      "a done merge shows before a read has it",
    ).toMatchObject({
      kind: "merged",
      title: "Merged into main",
      text: "Merged as 4444444 just now.",
    });
  });

  it("says the read shows the head branch deleted", () => {
    const merged = pull({
      state: { kind: "merged", at },
      head: { ...pull().head, ref: null },
    });
    expect(shownBox(merged, "adam", ago, idle, tracked).text).toBe(
      "Merged just now. fix/sync-stall was deleted on GitHub. Your local branch pr/127 is still here.",
    );
  });

  it("names why a merge didn't happen, and lets the user move on", () => {
    expect(
      shownBox(
        pull(),
        "adam",
        ago,
        {
          kind: "refused",
          message: "GitHub didn't do it: Required status check is failing.",
          expectedHead: oid("1"),
        },
        none,
      ),
    ).toMatchObject({
      kind: "failed",
      title: "GitHub didn't merge this",
      text: "GitHub didn't do it: Required status check is failing. Nothing was merged.",
      action: { kind: "retry" },
    });
    expect(
      shownBox(
        pull(),
        "adam",
        ago,
        {
          kind: "notSent",
          message: "L1 Git could not reach GitHub, so it sent nothing.",
        },
        none,
      ),
    ).toMatchObject({
      kind: "failed",
      title: "L1 Git didn't merge this",
      text: "L1 Git could not reach GitHub, so it sent nothing.",
    });
    expect(
      shownBox(
        pull(),
        "adam",
        ago,
        {
          kind: "notLanded",
          message: "GitHub hasn't merged this pull request.",
        },
        none,
      ),
    ).toMatchObject({
      kind: "failed",
      title: "Nothing was merged",
      text: "GitHub hasn't merged this pull request.",
    });
  });
});

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
