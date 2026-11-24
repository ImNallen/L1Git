import { describe, expect, it } from "vitest";
import type { HostProblem } from "./host";
import type {
  Check,
  PullRequest,
  ReviewThread,
  TimelineEvent,
} from "./pullRequest";
import { pullRequestSchema } from "./pullRequest";
import {
  checkDuration,
  checkGroups,
  checksLine,
  checksStarted,
  checksSummary,
  checkUrl,
  commitDays,
  conversation,
  conversationCount,
  detailNotice,
  eventText,
  excerpt,
  headline,
  headName,
  leftOut,
  lineLabel,
  mergeBox,
  named,
  personName,
  pullState,
  reviewers,
  threadsLeftOut,
} from "./pullRequestDetail";

const oid = (digit: string) => digit.repeat(40);
const at = (minute: number) =>
  `2026-11-24T10:${String(minute).padStart(2, "0")}:00Z`;
const page = <T>(items: T[], total = items.length) => ({ items, total });

function pull(fields: Partial<PullRequest> = {}): PullRequest {
  return pullRequestSchema.parse({
    number: 128,
    title: "Review a replay",
    body: "",
    state: { kind: "open", draft: false },
    author: "maja",
    viewerIsAuthor: false,
    base: "main",
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
    },
    reviewers: [],
    checks: page([]),
    commits: page([]),
    timeline: page([]),
    threads: page([]),
    mergeable: "mergeable",
    mergeState: "clean",
    ...fields,
  });
}

const commit = (digit: string, minute: number, by: string | null = "maja") => ({
  id: `C${digit}`,
  kind: "commit" as const,
  oid: oid(digit),
  headline: `Commit ${digit}`,
  by,
  at: at(minute),
});
const review = (
  id: string,
  minute: number,
  fields: Partial<Extract<TimelineEvent, { kind: "review" }>> = {},
) => ({
  kind: "review" as const,
  id,
  state: "commented" as const,
  body: "",
  by: "sara",
  at: at(minute),
  ...fields,
});
const comment = (
  minute: number,
  body = "Nice",
  by: string | null = "jonas",
) => ({
  id: `K${minute}`,
  kind: "comment" as const,
  body,
  by,
  at: at(minute),
});
function thread(
  id: string,
  fields: Partial<ReviewThread> = {},
  minute = 5,
): ReviewThread {
  return {
    id,
    review: null,
    path: "src/a.ts",
    line: 3,
    startLine: null,
    originalLine: 3,
    originalStartLine: null,
    side: "right",
    outdated: false,
    resolved: false,
    hunk: "",
    comments: page([
      { id: `${id}-1`, body: "Why?", by: "sara", at: at(minute) },
    ]),
    ...fields,
  };
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

describe("the notice", () => {
  const repository = {
    key: "octo/app",
    name: "app",
    github: { owner: "octo", repo: "app" },
  };
  const status = {
    revision: 1,
    github: { kind: "notConnected" as const, ended: null },
    deviceSignIn: false,
    deviceCode: null,
  };
  const failure = { message: "It failed.", status };
  const url = "https://github.com/orgs/octo/sso";
  const notice = (problem: HostProblem | null, value: PullRequest | null) =>
    detailNotice({ value, at: 5, reading: false, problem }, repository);
  const connection = { kind: "connection", message: "It failed." };

  it.each<[HostProblem | null, unknown]>([
    [null, null],
    [
      { kind: "unreachable", ...failure },
      { kind: "offline", at: 5 },
    ],
    [
      { kind: "transport", message: "It failed." },
      { kind: "offline", at: 5 },
    ],
    [{ kind: "gitHubFailed", httpStatus: 502, ...failure }, connection],
    [{ kind: "notFound", ...failure }, connection],
    [
      { kind: "ssoRequired", url, ...failure },
      { kind: "repository", repository, message: "It failed.", authorize: url },
    ],
  ])("%#", (problem, shown) => {
    expect(notice(problem, pull())).toEqual(shown);
    expect(notice(problem, null), "nothing is shown yet").toBeNull();
  });
});

describe("names", () => {
  it.each([
    ["octo", "You"],
    ["OCTO", "You"],
    ["maja", "maja"],
    [null, "ghost"],
  ])("%s is %s", (login, shown) => {
    expect(personName(login, "octo")).toBe(shown);
  });

  it("never calls a deleted account you", () => {
    expect(personName(null, null)).toBe("ghost");
  });

  it.each([
    [[], ""],
    [["a"], "a"],
    [["a", "b"], "a and b"],
    [["a", "b", "c"], "a, b and c"],
    [["a", "b", "c", "d"], "a, b and 2 more"],
  ])("%j reads %s", (names, shown) => {
    expect(named(names)).toBe(shown);
  });
});

describe("the headline", () => {
  const six = { commits: page([], 6) };
  const merged = {
    state: { kind: "merged" as const, at: at(9) },
    timeline: page<TimelineEvent>([
      { id: "E1", kind: "merged", oid: oid("4"), by: "octo", at: at(9) },
    ]),
  };
  it.each<[string, PullRequest, string]>([
    ["open", pull(six), "maja wants to merge 6 commits into"],
    [
      "yours",
      pull({ ...six, author: "octo", viewerIsAuthor: true }),
      "You want to merge 6 commits into",
    ],
    [
      "one commit",
      pull({ commits: page([], 1) }),
      "maja wants to merge 1 commit into",
    ],
    [
      "a deleted author",
      pull({ ...six, author: null }),
      "ghost wants to merge 6 commits into",
    ],
    ["merged", pull({ ...six, ...merged }), "You merged 6 commits into"],
    [
      "merged long ago, so its event is not listed",
      pull({ ...six, state: merged.state }),
      "Merged 6 commits into",
    ],
    [
      "closed",
      pull({ ...six, state: { kind: "closed", at: at(9) } }),
      "maja wanted to merge 6 commits into",
    ],
  ])("%s", (_, of, text) => {
    expect(headline(of, of, "octo")).toBe(text);
  });

  it("leaves the commits out until they were read", () => {
    expect(headline(pull(), null, "octo")).toBe("maja wants to merge into");
  });

  it("names the owner of a fork's branch, while the fork exists", () => {
    const { head } = pull();
    const fork = { ...head, crossRepository: true };
    expect(headName({ head })).toBe("feat/replay");
    expect(headName({ head: fork })).toBe("octo:feat/replay");
    expect(headName({ head: { ...fork, repository: null } })).toBe(
      "feat/replay",
    );
  });

  it("knows a draft", () => {
    expect(pullState({ state: { kind: "open", draft: true } })).toBe("draft");
    expect(pullState({ state: { kind: "closed", at: at(1) } })).toBe("closed");
  });
});

const outline = (of: Partial<PullRequest>) =>
  conversation(pull(of)).map((entry) => {
    switch (entry.kind) {
      case "commits":
        return `commits ${entry.by} ${entry.commits.map(({ oid }) => oid[0]).join("")}`;
      case "review":
        return `review ${entry.key} ${entry.threads.map(({ id }) => id).join("")}`;
      case "event":
        return entry.event.kind;
      default:
        return entry.kind === "thread"
          ? `thread ${entry.key}`
          : `comment ${entry.body}`;
    }
  });

describe("the conversation", () => {
  it("folds commits of one person in a row", () => {
    expect(
      outline({
        timeline: page<TimelineEvent>([
          commit("1", 1),
          commit("2", 2),
          commit("3", 3, "jonas"),
          comment(4),
          commit("4", 5, "jonas"),
        ]),
      }),
    ).toEqual([
      "commits maja 12",
      "commits jonas 3",
      "comment Nice",
      "commits jonas 4",
    ]);
  });

  it("shows a verdict without words as a line, and drops an empty comment", () => {
    expect(
      outline({
        timeline: page<TimelineEvent>([
          review("R1", 1, { state: "approved" }),
          review("R2", 2),
          review("R3", 3, { body: "  \n" }),
          review("R4", 4, { body: "See below" }),
          review("R5", 5, { state: "changesRequested", body: "No" }),
          review("R6", 6, { state: "dismissed" }),
        ]),
      }),
    ).toEqual(["review", "review R4 ", "review R5 ", "review"]);
  });

  it("puts a thread in its review, or at its first comment's time", () => {
    expect(
      outline({
        timeline: page<TimelineEvent>([
          comment(1, "first"),
          // Rebased, so its date is not where it stands.
          commit("1", 0),
          review("R1", 3),
          comment(9, "last"),
        ]),
        threads: page([
          thread("T1", { review: "R1" }),
          thread("T2", { review: "R1" }),
          thread("T3", { review: "R0" }, 5),
          thread("T4", {}, 59),
          thread("T5", { comments: page([], 2) }),
        ]),
      }),
    ).toEqual([
      "comment first",
      "commits maja 1",
      "review R1 T1T2",
      "thread T3",
      "comment last",
      "thread T4",
      "thread T5",
    ]);
  });

  it("leaves out the closing that a merge brings", () => {
    expect(
      outline({
        timeline: page<TimelineEvent>([
          { id: "E2", kind: "closed", by: "maja", at: at(1) },
          { id: "E3", kind: "reopened", by: "maja", at: at(2) },
          { id: "E4", kind: "merged", oid: oid("4"), by: "maja", at: at(3) },
          { id: "E5", kind: "closed", by: "maja", at: at(3) },
          { id: "E6", kind: "branchDeleted", by: "maja", at: at(4) },
        ]),
      }),
    ).toEqual(["closed", "reopened", "merged", "branchDeleted"]);
  });

  it("reads without threads", () => {
    expect(
      outline({
        threads: null,
        timeline: page<TimelineEvent>([review("R1", 1, { body: "Hm" })]),
      }),
    ).toEqual(["review R1 "]);
  });

  it.each<[Parameters<typeof eventText>[0], string]>([
    [
      {
        id: "E7",
        kind: "forcePushed",
        from: oid("4"),
        to: oid("5"),
        by: "a",
        at: at(1),
      },
      "force-pushed 4444444..5555555",
    ],
    [
      {
        id: "E8",
        kind: "forcePushed",
        from: null,
        to: oid("5"),
        by: "a",
        at: at(1),
      },
      "force-pushed to 5555555",
    ],
    [
      {
        id: "E9",
        kind: "forcePushed",
        from: oid("4"),
        to: null,
        by: "a",
        at: at(1),
      },
      "force-pushed this branch",
    ],
    [
      { id: "E10", kind: "merged", oid: oid("4"), by: "a", at: at(1) },
      "merged 4444444 into main",
    ],
    [
      { id: "E11", kind: "merged", oid: null, by: "a", at: at(1) },
      "merged this into main",
    ],
    [{ id: "E12", kind: "closed", by: "a", at: at(1) }, "closed this"],
    [{ id: "E13", kind: "reopened", by: "a", at: at(1) }, "reopened this"],
    [
      { id: "E14", kind: "branchDeleted", by: "a", at: at(1) },
      "deleted feat/replay",
    ],
    [
      { id: "E15", kind: "readyForReview", by: "a", at: at(1) },
      "marked this as ready for review",
    ],
    [
      { id: "E16", kind: "convertedToDraft", by: "a", at: at(1) },
      "marked this as a draft",
    ],
    [review("R", 1, { state: "approved" }), "approved these changes"],
    [review("R", 1, { state: "changesRequested" }), "requested changes"],
    [
      review("R", 1, { state: "dismissed" }),
      "left a review that was dismissed",
    ],
  ])("says %j", (event, text) => {
    expect(eventText(event, pull())).toBe(text);
  });

  it("counts what was said, and says when it can't count it all", () => {
    const said = {
      timeline: page<TimelineEvent>([
        comment(1),
        review("R1", 2, { body: "Hm" }),
        review("R2", 3, { state: "approved" }),
        commit("1", 4),
      ]),
      threads: page([thread("T1", { comments: page([], 3) })]),
    };
    expect(conversationCount(pull(said))).toBe("5");
    expect(conversationCount(pull({ ...said, threads: null }))).toBe("2+");
    expect(
      conversationCount(
        pull({ ...said, timeline: page(said.timeline.items, 300) }),
      ),
    ).toBe("5+");
  });

  it.each([
    [0, 0, null],
    [100, 331, "Earlier activity isn't shown."],
    [3, 4, "Some activity isn't shown."],
  ])("%i of %i", (items, total, text) => {
    const timeline = page<TimelineEvent>(
      Array.from({ length: items }, (_, index) => comment(index % 60)),
      total,
    );
    expect(leftOut({ timeline })).toBe(text);
  });

  it("says how many threads it shows", () => {
    expect(threadsLeftOut({ threads: page([thread("T1")], 140) })).toBe(
      "1 of 140 review threads are shown.",
    );
    expect(threadsLeftOut({ threads: page([thread("T1")]) })).toBeNull();
    expect(threadsLeftOut({ threads: null })).toBeNull();
  });
});

describe("a thread's lines", () => {
  it.each([
    [{ line: 88 }, "Line 88"],
    [{ line: 88, startLine: 85 }, "Lines 85–88"],
    [{ line: 30, startLine: 30 }, "Line 30"],
    [{ line: null, originalLine: 12, originalStartLine: 10 }, "Lines 10–12"],
    [{ line: null, originalLine: null }, "Whole file"],
  ])("%j", (fields, label) => {
    expect(lineLabel(thread("T", fields))).toBe(label);
  });

  const patch = (hunk: string, fields: Partial<ReviewThread> = {}) => {
    const shown = excerpt(thread("T", { hunk, originalLine: null, ...fields }));
    return shown?.kind === "diff"
      ? shown.patch.split("\n").slice(2, -1)
      : shown;
  };
  const lines = (count: number, mark = " ") =>
    Array.from({ length: count }, (_, index) => `${mark}${index + 1}`);

  it("keeps a short hunk whole", () => {
    expect(patch("@@ -1,2 +1,2 @@ fn main\n-a\n+b\n c")).toEqual([
      "@@ -1,2 +1,2 @@",
      "-a",
      "+b",
      " c",
    ]);
  });

  it("shows the last four lines under the right numbers", () => {
    expect(
      patch(["@@ -10,9 +20,9 @@", ...lines(6), "-x", "+y", " z"].join("\n")),
    ).toEqual(["@@ -15,3 +25,3 @@", " 6", "-x", "+y", " z"]);
  });

  it("shows the commented range, up to twelve lines", () => {
    const hunk = ["@@ -0,0 +1,30 @@", ...lines(30, "+")].join("\n");
    const range = (start: number) =>
      patch(hunk, { originalLine: 30, originalStartLine: start });
    expect(range(24)).toEqual([
      "@@ -0,0 +24,7 @@",
      ...lines(30, "+").slice(23),
    ]);
    expect(range(2)).toHaveLength(13);
    expect(range(29), "never fewer than four").toHaveLength(5);
  });

  it("counts the old side for a comment on deleted lines", () => {
    const hunk = ["@@ -5,8 +5,1 @@", " a", ...lines(7, "-")].join("\n");
    expect(
      patch(hunk, { side: "left", originalLine: 12, originalStartLine: 7 }),
    ).toEqual(["@@ -7,6 +5,0 @@", ...lines(7, "-").slice(1)]);
  });

  it("numbers a side that has no lines left by the line before", () => {
    const hunk = ["@@ -3,1 +3,6 @@", " a", ...lines(5, "+")].join("\n");
    expect(patch(hunk)?.[0 as never]).toBe("@@ -3,0 +5,4 @@");
  });

  it("keeps the mark of a missing last newline", () => {
    expect(
      patch("@@ -1,1 +1,1 @@\n-a\n\\ No newline at end of file\n+b"),
    ).toEqual(["@@ -1,1 +1,1 @@", "-a", "\\ No newline at end of file", "+b"]);
  });

  it("reads an empty line as context", () => {
    expect(patch("@@ -1,2 +1,2 @@\n a\n\n b")).toEqual([
      "@@ -1,3 +1,3 @@",
      " a",
      " ",
      " b",
    ]);
  });

  it("falls back to text, and to nothing", () => {
    expect(patch("not a hunk\nat all")).toEqual({
      kind: "text",
      text: "not a hunk\nat all",
    });
    expect(patch("@@ -1,1 +1,1 @@\n~odd")).toEqual({
      kind: "text",
      text: "@@ -1,1 +1,1 @@\n~odd",
    });
    expect(patch("@@ -1,1 +1,1 @@")).toMatchObject({ kind: "text" });
    expect(patch(" \n")).toBeNull();
  });
});

it("labels the reviewers", () => {
  expect(
    reviewers(
      pull({
        reviewers: [
          { login: "jonas", state: "approved" },
          { login: "sara", state: "changesRequested" },
          { login: "octo", state: "requested" },
          { login: "codex", state: "commented" },
          { login: "old", state: "dismissed" },
          { login: null, state: "requested" },
        ],
      }),
      "octo",
    ).map(({ name, label }) => `${name}: ${label}`),
  ).toEqual([
    "jonas: Approved",
    "sara: Changes requested",
    "You: Waiting on you",
    "codex: Commented",
    "old: Dismissed",
    "A team: Waiting",
  ]);
});

describe("checks", () => {
  const mixed = [
    check("a", "passed"),
    check("b", "skipped"),
    check("c", "failed"),
    check("d", "running"),
    check("e", "passed"),
    check("f", "failed"),
  ];

  it("groups the worst first", () => {
    expect(
      checkGroups(mixed).map(
        ({ state, checks }) =>
          `${state} ${checks.map(({ name }) => name).join("")}`,
      ),
    ).toEqual(["failed cf", "running d", "passed ae", "skipped b"]);
    expect(checksLine(mixed)).toBe("2 failing, 1 running, 2 passed, 1 skipped");
  });

  it.each<[PullRequest["checks"], string]>([
    [null, "No access"],
    [page([]), "None"],
    [page(mixed), "2 failing"],
    [page([check("a", "passed"), check("b", "running")]), "1 of 2 passed"],
    [page([check("a", "passed"), check("b", "skipped")]), "1 of 1 passed"],
    [page([check("b", "skipped")]), "All skipped"],
    [page([check("a", "passed")], 41), "1 passed, 40 not shown"],
  ])("sums up %#", (checks, label) => {
    expect(checksSummary(checks).label).toBe(label);
  });

  it.each([
    [0, 48, "48s"],
    [0, 252, "4m 12s"],
    [0, 362, "6m 02s"],
    [0, 3_840, "1h 04m"],
    [60, 0, null],
  ])("from %i to %i seconds took %s", (from, to, took) => {
    const time = (seconds: number) =>
      new Date(Date.UTC(2026, 10, 24) + seconds * 1_000).toISOString();
    expect(
      checkDuration(
        check("a", "passed", { startedAt: time(from), completedAt: time(to) }),
        0,
      ),
    ).toBe(took);
  });

  it("counts a running one until now, and says nothing without times", () => {
    const now = Date.parse(at(3)) / 1_000;
    const running = check("a", "running", { startedAt: at(1) });
    expect(checkDuration(running, now)).toBe("2m 00s");
    expect(checkDuration({ ...running, state: "passed" }, now)).toBeNull();
    expect(checkDuration(check("a", "passed"), now)).toBeNull();
  });

  it("finds the first start", () => {
    expect(
      checksStarted([
        check("a", "passed", { startedAt: at(4) }),
        check("b", "passed", { startedAt: at(2) }),
        check("c", "passed"),
      ]),
    ).toBe(at(2));
    expect(checksStarted([])).toBeNull();
  });

  it.each([
    ["https://github.com/octo/app/actions/runs/1", true],
    ["http://ci.example/1", false],
    ["javascript:alert(1)", false],
    [null, false],
  ])("opens %s: %s", (url, opens) => {
    expect(checkUrl(check("a", "passed", { url })) !== null).toBe(opens);
  });
});

describe("commit days", () => {
  const now = new Date(2026, 10, 24, 18);
  const on = (month: number, day: number, hour = 12, year = 2026) =>
    new Date(year, month, day, hour).toISOString();
  const days = (
    commits: { oid: string; at: string }[],
    pushes: string[] = [],
  ) =>
    commitDays(
      pull({
        commits: page(
          commits.map((each) => ({ ...each, headline: "", by: "maja" })),
        ),
        timeline: page<TimelineEvent>(
          pushes.map((at) => ({
            id: "P1",
            kind: "forcePushed",
            from: null,
            to: null,
            by: "maja",
            at,
          })),
        ),
      }),
      now,
      "en-GB",
    ).map(
      ({ label, commits, items }) =>
        `${label} ${commits}: ${items.map((item) => (item.kind === "commit" ? item.commit.oid : "push")).join(" ")}`,
    );

  it("goes by day, newest first", () => {
    expect(
      days([
        { oid: "a", at: on(10, 3, 9, 2025) },
        { oid: "b", at: on(10, 3) },
        { oid: "c", at: on(10, 23) },
        { oid: "d", at: on(10, 24, 1) },
        { oid: "e", at: on(10, 24, 2) },
      ]),
    ).toEqual([
      "Today 2: e d",
      "Yesterday 1: c",
      "Tuesday 3 November 1: b",
      expect.stringMatching(/^Monday,? 3 November 2025 1: a$/),
    ]);
  });

  it("puts a force push above the commits it replaced", () => {
    expect(
      days(
        [
          { oid: "a", at: on(10, 3) },
          { oid: "b", at: on(10, 24, 9) },
        ],
        [on(10, 24, 8), on(10, 1)],
      ),
    ).toEqual([
      "Today 1: b push",
      "Tuesday 3 November 1: a",
      "Sunday 1 November 0: push",
    ]);
  });
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
      mergeBox(pull(fields), null, () => "").act;
    expect(acts({ mergeable: "conflicting" })).toBe(true);
    expect(acts({ state: { kind: "open", draft: true } })).toBe(true);
    expect(acts({})).toBe(false);
    expect(acts({ mergeState: "unknown" })).toBe(false);
  });
});
