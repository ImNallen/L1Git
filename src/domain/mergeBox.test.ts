import { describe, expect, it } from "vitest";
import { mergeBox } from "./mergeBox";
import type { Check, PullRequest, TimelineEvent } from "./pullRequest";
import { pullRequestSchema } from "./pullRequest";

const oid = (digit: string) => digit.repeat(40);
const at = (minute: number) =>
  `2026-11-24T10:${String(minute).padStart(2, "0")}:00Z`;
const page = <T>(items: T[], total = items.length) => ({ items, total });

function pull(fields: Partial<PullRequest> = {}): PullRequest {
  return pullRequestSchema.parse({
    id: "PR_128",
    repositoryId: "R_1",
    number: 128,
    title: "Review a replay",
    body: "",
    state: { kind: "open", draft: false },
    author: "maja",
    viewerIsAuthor: false,
    viewerPermission: "write",
    base: "main",
    baseOid: oid("b"),
    labels: page([]),
    additions: 1,
    deletions: 2,
    changedFiles: 1,
    createdAt: at(0),
    updatedAt: at(0),
    head: {
      branch: "feat/replay",
      oid: oid("1"),
      repository: { owner: "octo", repo: "app" },
      crossRepository: false,
      maintainerCanModify: false,
      ref: { id: "REF_1", othersOpen: 0, viewerCanDelete: true },
    },
    reviewers: [],
    checks: page([]),
    commits: page([]),
    timeline: page([]),
    threads: page([]),
    mergeable: "mergeable",
    mergeState: "clean",
    decision: null,
    merge: {
      allowed: { merge: true, squash: true, rebase: true },
      preferred: "merge",
      deletesBranch: false,
    },
    pending: { kind: "none" },
    ...fields,
  });
}

const check = (
  name: string,
  state: Check["state"],
  fields: Partial<Check> = {},
): Check => ({
  name,
  state,
  required: false,
  startedAt: null,
  completedAt: null,
  url: null,
  ...fields,
});

describe("the merge box", () => {
  const passed = (count: number) =>
    Array.from({ length: count }, (_, index) => check(`ok ${index}`, "passed"));
  const reviewed = (
    ...states: [string | null, PullRequest["reviewers"][number]["state"]][]
  ) => ({ reviewers: states.map(([login, state]) => ({ login, state })) });
  const blocked = { mergeState: "blocked" as const };
  const unstable = { mergeState: "unstable" as const };
  const failing = check("lint", "failed");
  const required = check("test", "failed", { required: true });
  const runs = check("desktop", "running", { required: true });

  it.each<[string, Partial<PullRequest>, string, string, string]>([
    [
      "merged, whatever else it says",
      {
        state: { kind: "merged", at: at(1) },
        mergeable: "conflicting",
        timeline: page<TimelineEvent>([
          { id: "E17", kind: "merged", oid: oid("4"), by: "maja", at: at(1) },
        ]),
      },
      "merged",
      "Merged into main",
      "Merged as 4444444 an hour ago.",
    ],
    [
      "merged without its event",
      { state: { kind: "merged", at: at(1) } },
      "merged",
      "Merged into main",
      "Merged an hour ago.",
    ],
    [
      "closed",
      { state: { kind: "closed", at: at(1) } },
      "closed",
      "Closed",
      "Closed without merging an hour ago.",
    ],
    [
      "a draft, even with conflicts",
      { state: { kind: "open", draft: true }, mergeable: "conflicting" },
      "draft",
      "Draft",
      "Code owners aren't asked to review yet. It can't merge while it's a draft.",
    ],
    [
      "conflicts",
      { mergeable: "conflicting", mergeState: "dirty" },
      "conflicts",
      "Conflicts with main",
      "The conflicts have to be resolved before this can merge.",
    ],
    [
      "changes requested, blocked",
      { ...blocked, ...reviewed(["sara", "changesRequested"]) },
      "changesRequested",
      "Changes requested",
      "sara asked for changes, and GitHub is blocking the merge.",
    ],
    [
      "changes requested by you, not blocked",
      reviewed(["octo", "changesRequested"], ["sara", "changesRequested"]),
      "changesRequested",
      "Changes requested",
      "You and sara asked for changes.",
    ],
    [
      "a review missing",
      { ...blocked, ...reviewed(["octo", "requested"], [null, "requested"]) },
      "reviewRequired",
      "Review required",
      "GitHub is blocking the merge. Waiting for you and a team to review.",
    ],
    [
      "a review missing where nothing blocks",
      { ...reviewed(["sara", "requested"]), checks: page(passed(2)) },
      "ready",
      "Ready to merge",
      "All 2 checks passed.",
    ],
    [
      "a failing required check, which explains the block",
      {
        ...blocked,
        ...reviewed(["sara", "requested"]),
        checks: page([...passed(1), required, failing]),
      },
      "requiredFailing",
      "1 required check is failing",
      "test must pass before this can merge.",
    ],
    [
      "behind",
      { mergeState: "behind" },
      "behind",
      "Behind main",
      "main only accepts branches that are up to date with it.",
    ],
    [
      "blocked without a reason in sight",
      { ...blocked, checks: page(passed(3)) },
      "blocked",
      "Merging is blocked",
      "GitHub is blocking the merge, and nobody has approved this yet.",
    ],
    [
      "blocked although approved",
      { ...blocked, ...reviewed(["jonas", "approved"]) },
      "blocked",
      "Merging is blocked",
      "GitHub is blocking the merge and doesn't tell L1 Git which rule asks for more.",
    ],
    [
      "failing, not required",
      { ...unstable, checks: page([failing, failing, ...passed(1)]) },
      "failing",
      "2 checks are failing",
      "None of them is required on main, so this can still merge.",
    ],
    [
      "failing, with checks left out",
      { ...unstable, checks: page([failing], 140) },
      "failing",
      "1 check is failing",
      "This can still merge.",
    ],
    [
      "failing while GitHub is still thinking",
      { mergeState: "unknown", checks: page([failing]) },
      "failing",
      "1 check is failing",
      "GitHub hasn't said yet whether this can merge.",
    ],
    [
      "running, required",
      { ...blocked, checks: page([...passed(9), runs]) },
      "running",
      "9 of 10 checks done",
      "Merging waits for 1 required check.",
    ],
    [
      "running, not required",
      { ...unstable, checks: page([...passed(9), check("slow", "running")]) },
      "running",
      "9 of 10 checks done",
      "None of the others is required, so this can merge now.",
    ],
    [
      "running, with checks left out",
      { ...unstable, checks: page([check("slow", "running")], 140) },
      "running",
      "1 check is running",
      "This can merge now.",
    ],
    [
      "ready, approved",
      {
        ...reviewed(["jonas", "approved"]),
        checks: page([...passed(14), check("x", "skipped")]),
      },
      "ready",
      "Ready to merge",
      "Approved by jonas, and all 14 checks passed.",
    ],
    [
      "ready, without checks",
      reviewed(["jonas", "approved"]),
      "ready",
      "Ready to merge",
      "Approved by jonas.",
    ],
    [
      "ready, with one check",
      { mergeState: "hasHooks", checks: page(passed(1)) },
      "ready",
      "Ready to merge",
      "The only check passed.",
    ],
    [
      "never ready while GitHub is still working it out",
      {
        mergeable: "unknown",
        ...reviewed(["jonas", "approved"]),
        checks: page(passed(2)),
      },
      "unknown",
      "Can't tell yet",
      "GitHub hasn't said yet whether this can merge.",
    ],
    [
      "failing, with no promise while GitHub is still working it out",
      { ...unstable, mergeable: "unknown", checks: page([failing]) },
      "failing",
      "1 check is failing",
      "GitHub hasn't said yet whether this can merge.",
    ],
    [
      "unstable, when the checks can't be read",
      { ...unstable, ...reviewed(["jonas", "approved"]), checks: null },
      "unknown",
      "A check hasn't passed",
      "It isn't required, so this can still merge. L1 Git can't see which one it is.",
    ],
    [
      "unstable, with checks left out",
      { ...unstable, checks: page(passed(100), 140) },
      "unknown",
      "A check hasn't passed",
      "It isn't required, so this can still merge. L1 Git can't see which one it is.",
    ],
    [
      "ready, when the checks can't be read",
      { checks: null },
      "ready",
      "Ready to merge",
      "GitHub finds nothing that stops it.",
    ],
    [
      "ready, with checks left out",
      { checks: page(passed(100), 140) },
      "ready",
      "Ready to merge",
      "GitHub finds nothing that stops it.",
    ],
    [
      "unknown",
      { mergeable: "unknown", mergeState: "unknown" },
      "unknown",
      "Can't tell yet",
      "GitHub hasn't said yet whether this can merge.",
    ],
  ])("%s", (_, fields, kind, title, text) => {
    expect(mergeBox(pull(fields), "octo", () => "an hour ago")).toMatchObject({
      kind,
      title,
      text,
    });
  });

  it("asks for a step on GitHub only when one is needed", () => {
    const acts = (fields: Partial<PullRequest>) =>
      mergeBox(pull(fields), null, () => "").action.kind;
    expect(acts({ mergeable: "conflicting" })).toBe("openOnGitHub");
    expect(acts({ state: { kind: "open", draft: true } })).toBe("openOnGitHub");
    expect(acts({})).toBe("merge");
    expect(acts({ mergeState: "unknown" })).toBe("none");
  });

  it("says why it offers no merge when GitHub didn't say your role", () => {
    const unsure = { viewerPermission: "unknown" } as const;
    expect(
      mergeBox(pull({ ...unsure, checks: page(passed(2)) }), "octo", () => ""),
    ).toMatchObject({
      kind: "ready",
      title: "Ready to merge",
      text: "All 2 checks passed. GitHub didn't say whether you can merge here.",
      action: { kind: "openOnGitHub" },
    });
    expect(
      mergeBox(pull({ ...unsure, mergeState: "unknown" }), "octo", () => ""),
      "where no merge was on offer, nothing is said of the role",
    ).toMatchObject({
      kind: "unknown",
      text: "GitHub hasn't said yet whether this can merge.",
      action: { kind: "none" },
    });
  });
});
