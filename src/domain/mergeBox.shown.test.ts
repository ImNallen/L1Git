import { describe, expect, it } from "vitest";
import { shownBox } from "./mergeBox";
import type { MergeProgress } from "./mergeBox";
import type { Check, PullRequest } from "./pullRequest";
import { pullRequestSchema } from "./pullRequest";
import type { LocalDelete } from "./pullRequestMerge";
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
    expect(
      shownBox(pull(fields), "adam", ago, progress, local, null),
    ).toMatchObject(expected);
  });
});

describe("what the merge box offers", () => {
  const actionOf = (
    fields: Partial<PullRequest>,
    progress: MergeProgress = idle,
    local: LocalDelete = none,
  ) => shownBox(pull(fields), "adam", ago, progress, local, null).action;

  it("offers a merge only to a role that can merge", () => {
    for (const viewerPermission of ["write", "maintain", "admin"] as const)
      expect(actionOf({ viewerPermission })).toEqual({
        kind: "merge",
        anyway: false,
      });
    expect(actionOf({ viewerPermission: "triage" })).toEqual({ kind: "none" });
    expect(
      shownBox(
        pull({ viewerPermission: "unknown" }),
        "adam",
        ago,
        idle,
        none,
        null,
      ),
      "an unknown role is no claim that you can't, so it sends you to GitHub",
    ).toMatchObject({ kind: "ready", action: { kind: "openOnGitHub" } });
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
      shownBox(
        pull(),
        "adam",
        ago,
        { kind: "unknown", kept: true },
        none,
        null,
      ),
    ).toMatchObject({
      kind: "checking",
      title: "L1 Git can't tell yet whether this merged",
      text: "L1 Git sent the merge to GitHub and got no answer, so it may have merged. L1 Git looks again each time it reads this pull request.",
      action: { kind: "openOnGitHub" },
    });
    expect(
      shownBox(
        pull(),
        "adam",
        ago,
        { kind: "unknown", kept: false },
        none,
        null,
      ),
      "with nothing kept to look for, the user moves on",
    ).toMatchObject({
      text: "L1 Git sent the merge to GitHub and got no answer, so it may have merged. L1 Git isn't looking for it any more. Review the pull request before you merge again.",
      action: { kind: "retry" },
    });
  });

  it("shows the read over a write it settled", () => {
    const merged = pull({ state: { kind: "merged", at } });
    expect(
      shownBox(
        merged,
        "adam",
        ago,
        { kind: "unknown", kept: true },
        none,
        null,
      ),
    ).toMatchObject({ kind: "merged", action: { kind: "none" } });
    expect(
      shownBox(
        pull(),
        "adam",
        ago,
        { kind: "done", commit: oid("4") },
        none,
        null,
      ),
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
    expect(shownBox(merged, "adam", ago, idle, tracked, null).text).toBe(
      "Merged just now. fix/sync-stall was deleted on GitHub. Your local branch pr/127 is still here.",
    );
  });

  it("offers the branch delete a merge with no answer skipped", () => {
    const merged = pull({ state: { kind: "merged", at } });
    expect(
      shownBox(
        merged,
        "adam",
        ago,
        { kind: "unknown", kept: true },
        tracked,
        "fix/sync-stall",
      ),
    ).toMatchObject({
      kind: "merged",
      text: "Merged just now. L1 Git got no answer to the merge, so it didn't delete fix/sync-stall on GitHub. Your local branch pr/127 is still here.",
      action: { kind: "deleteRemote", branch: "fix/sync-stall" },
    });
    expect(
      shownBox(merged, "adam", ago, idle, tracked, null).action,
      "with nothing left on GitHub, the local branch is the one to offer",
    ).toEqual({ kind: "deleteLocal" });
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
        null,
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
        null,
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
        null,
      ),
    ).toMatchObject({
      kind: "failed",
      title: "Nothing was merged",
      text: "GitHub hasn't merged this pull request.",
    });
  });
});
