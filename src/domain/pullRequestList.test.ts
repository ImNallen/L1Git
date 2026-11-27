import { describe, expect, it } from "vitest";
import type { Read } from "../pullRequests";
import type { OverviewView, RootState } from "../overview";
import type { HostProblem } from "./host";
import { overviewSchema } from "./overview";
import { pullRequestsSchema } from "./pullRequest";
import type { PullRequests, PullRequestSummary } from "./pullRequest";
import {
  addedSegments,
  checksOf,
  elsewhereText,
  initialChoices,
  listModel,
  notices,
  pullRequestUrl,
  reviewPill,
  rowState,
  savedRepositories,
  sortLabel,
  waiting,
  waitingText,
} from "./pullRequestList";
import type { Choices, ListedRepository, ReadOf } from "./pullRequestList";
import type { RepositoryRoot } from "./repository";
import { rootSchema } from "./repository";

const none = { passed: 0, failed: 0, skipped: 0, running: 0 };

function pull(
  number: number,
  fields: Partial<PullRequestSummary> = {},
): PullRequestSummary {
  return {
    number,
    title: `Change ${number}`,
    state: { kind: "open", draft: false },
    author: "hubot",
    viewerIsAuthor: false,
    head: `branch-${number}`,
    base: "main",
    labels: { items: [], total: 0 },
    comments: 0,
    reviewRequested: false,
    review: null,
    checks: none,
    mergeable: "mergeable",
    additions: 1,
    deletions: 1,
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    ...fields,
  };
}

const draft = { kind: "open", draft: true } as const;
const merged = (at: string) => ({ kind: "merged", at }) as const;
const labels = (...names: string[]) => ({
  items: names.map((name) => ({ name, color: "0075ca" })),
  total: names.length,
});

const repository = (name: string): ListedRepository => ({
  key: `octo/${name}`,
  name,
  root: rootSchema.parse(`/work/${name}`),
  github: { owner: "octo", repo: name },
});
const app = repository("app");
const site = repository("site");
const api = repository("api");

type Held = Partial<Read<PullRequests>>;
const holds = (...items: PullRequestSummary[]): Held => ({
  value: { items, total: items.length },
  at: 1_000,
});
const problem = (kind: string, more: object = {}): HostProblem =>
  ({ kind, message: `${kind}.`, ...more }) as HostProblem;
const failing = (kind: string, more?: object): Held => ({
  problem: problem(kind, more),
});

const reads =
  (open: Record<string, Held>, recent: Record<string, Held> = {}): ReadOf =>
  ({ name }, list) => ({
    value: null,
    at: null,
    askedAt: null,
    reading: false,
    problem: null,
    ...(list === "open" ? open : recent)[name],
  });

const choose = (choices: Partial<Choices> = {}): Choices => ({
  ...initialChoices,
  ...choices,
});

const listed = [app, site];
const model = (readOf: ReadOf, choices?: Partial<Choices>) =>
  listModel(listed, readOf, choose(choices));
function numbers(readOf: ReadOf, choices?: Partial<Choices>) {
  const { body } = model(readOf, choices);
  return body.kind === "rows"
    ? body.groups.flatMap((group) => group.rows.map((row) => row.pull.number))
    : body.kind;
}

it("keeps the fixture in the shape Rust answers", () => {
  expect(
    pullRequestsSchema.parse({ items: [pull(1)], total: 1 }).items,
  ).toEqual([pull(1)]);
});

describe("the saved repositories", () => {
  const root = (path: string) => rootSchema.parse(path);
  const overview = (commonDir: string, github: string | null) => {
    const [owner, repo] = github?.split("/") ?? [];
    return {
      commonDir: root(commonDir),
      overview: overviewSchema.parse({
        root: commonDir,
        commonDir,
        name: "app",
        github: github === null ? null : { owner, repo },
        branches: [],
        fetch: null,
      }),
    } as OverviewView["repositories"][number];
  };
  const entry = (path: string) => ({
    root: root(path),
    name: path.split("/").at(-1)!,
  });
  const open = (path: string, commonDir: string): [RepositoryRoot, RootState] =>
    [root(path), { kind: "open", commonDir: root(commonDir) }] as const;

  it("lists each GitHub repository once, by the first saved entry's shown name", () => {
    const saved = savedRepositories(
      [
        entry("/work/app"),
        entry("/work/notes"),
        entry("/home/app"),
        entry("/work/app-feature"),
        entry("/work/gone"),
        entry("/work/slow"),
      ],
      {
        roots: new Map<RepositoryRoot, RootState>([
          open("/work/app", "/work/app/.git"),
          open("/work/app-feature", "/work/app/.git"),
          open("/work/notes", "/work/notes/.git"),
          open("/home/app", "/home/app/.git"),
          [
            root("/work/gone"),
            {
              kind: "unavailable",
              problem: { kind: "missingPath", message: "Gone." },
            },
          ],
          [root("/work/slow"), { kind: "opening" }],
        ]),
        repositories: [
          overview("/home/app/.git", "octo/App"),
          overview("/work/app/.git", "Octo/app"),
          overview("/work/notes/.git", null),
        ],
      },
    );
    expect(saved).toEqual({
      listed: [
        {
          key: "octo/app",
          name: "app work",
          root: "/work/app",
          github: { owner: "Octo", repo: "app" },
        },
      ],
      elsewhere: 1,
      opening: true,
    });
  });

  it("stands for the first saved clone that loaded", () => {
    const roots = new Map<RepositoryRoot, RootState>([
      [
        root("/gone/app"),
        {
          kind: "unavailable",
          problem: { kind: "missingPath", message: "Gone." },
        },
      ],
      [root("/slow/app"), { kind: "opening" }],
      open("/work/app", "/work/app/.git"),
      open("/home/app", "/home/app/.git"),
    ]);
    const { listed } = savedRepositories(
      ["/gone/app", "/slow/app", "/work/app", "/home/app"].map(entry),
      {
        roots,
        repositories: [
          overview("/home/app/.git", "octo/app"),
          overview("/work/app/.git", "octo/app"),
        ],
      },
    );
    expect(listed.map((repository) => repository.root)).toEqual(["/work/app"]);
  });

  it("has not opened a repository the overview does not know yet", () => {
    expect(
      savedRepositories([entry("/work/app")], {
        roots: new Map(),
        repositories: [],
      }),
    ).toEqual({ listed: [], elsewhere: 0, opening: true });
  });

  it("says how many are not on GitHub", () => {
    expect(elsewhereText(1)).toBe("1 saved repository isn't on GitHub.");
    expect(elsewhereText(4)).toBe("4 saved repositories aren't on GitHub.");
  });
});

it("links a row to its pull request", () => {
  expect(pullRequestUrl(app.github, 12)).toBe(
    "https://github.com/octo/app/pull/12",
  );
});

describe("the state icon", () => {
  const failed = { ...none, passed: 3, failed: 1, running: 2 };
  const running = { ...none, passed: 3, running: 2 };
  it.each([
    ["merged", { state: merged("2026-11-01T00:00:00Z"), checks: failed }],
    ["closed", { state: { kind: "closed", at: "2026-11-01T00:00:00Z" } }],
    ["draft", { state: draft, checks: failed }],
    ["failing", { checks: failed, review: "changesRequested" }],
    ["running", { checks: running, review: "required" }],
    ["ready", {}],
    ["ready", { review: "approved", checks: { ...none, passed: 2 } }],
    ["ready", { checks: { ...none, skipped: 4 } }],
    ["open", { review: "required" }],
    ["open", { review: "changesRequested" }],
    ["open", { checks: null }],
    ["open", { mergeable: "conflicting" }],
    ["open", { mergeable: "unknown" }],
  ] as [string, Partial<PullRequestSummary>][])(
    "is %s for %o",
    (is, fields) => {
      expect(rowState(pull(1, fields))).toBe(is);
    },
  );
});

describe("the review pill", () => {
  it.each([
    [null, {}],
    ["approved", { review: "approved" }],
    ["changesRequested", { review: "changesRequested" }],
    ["required", { review: "required" }],
    ["yours", { review: "required", reviewRequested: true }],
    ["draft", { state: draft, reviewRequested: true }],
  ] as [string | null, Partial<PullRequestSummary>][])(
    "is %s for %o",
    (is, fields) => {
      expect(reviewPill(pull(1, fields))).toBe(is);
    },
  );
});

describe("the checks", () => {
  it.each([
    ["passed", "14/14", { ...none, passed: 14, skipped: 3 }],
    ["failing", "2 failing", { ...none, passed: 4, failed: 2, running: 1 }],
    ["running", "6 of 9", { ...none, passed: 6, running: 3 }],
    ["none", "–", { ...none, skipped: 2 }],
    ["noAccess", "No access", null],
  ] as [string, string, PullRequestSummary["checks"]][])(
    "are %s as %s",
    (kind, label, checks) => {
      expect(checksOf({ checks })).toEqual({ kind, label });
    },
  );
});

it.each([
  [612, 88, 4],
  [3, 0, 5],
  [58, 310, 1],
  [96, 96, 3],
  [0, 9, 0],
  [0, 0, null],
])("draws +%i -%i with %s added segments", (additions, deletions, added) => {
  expect(addedSegments({ additions, deletions })).toBe(added);
});

describe("the views", () => {
  const readOf = reads(
    {
      app: holds(
        pull(1, { reviewRequested: true }),
        pull(2, { viewerIsAuthor: true }),
        pull(3, { state: draft, viewerIsAuthor: true, reviewRequested: true }),
      ),
      site: holds(pull(4, { reviewRequested: true })),
    },
    { app: holds(pull(9, { state: merged("2026-11-02T00:00:00Z") })) },
  );

  it.each([
    ["open", [1, 2, 3, 4], "4 pull requests across 2 repositories"],
    ["review", [1, 4], "2 pull requests waiting on you"],
    ["mine", [2, 3], "2 pull requests across 2 repositories"],
    ["drafts", [3], "1 draft across 2 repositories"],
    ["merged", [9], "1 merged in the last 7 days"],
  ] as const)("%s lists %o", (view, shown, scope) => {
    expect(numbers(readOf, { view })).toEqual(shown);
    expect(model(readOf, { view }).scope).toBe(scope);
  });

  it("count only the checked repositories, and each repository's rows in the view", () => {
    expect(model(readOf, { view: "review" }).counts).toEqual({
      open: 4,
      review: 2,
      mine: 2,
      drafts: 1,
      merged: 1,
    });
    const { counts, repositories, scope } = model(readOf, {
      view: "review",
      unchecked: new Set([site.key]),
    });
    expect(counts).toEqual({
      open: 3,
      review: 1,
      mine: 2,
      drafts: 1,
      merged: 1,
    });
    expect(
      repositories.map(({ repository, checked, count }) => [
        repository.name,
        checked,
        count,
      ]),
    ).toEqual([
      ["app", true, 1],
      ["site", false, 0],
    ]);
    expect(scope).toBe("1 pull request waiting on you");
  });

  it("have no count before a list was read", () => {
    const { counts, repositories } = model(reads({}));
    expect(counts.open).toBeNull();
    expect(repositories.map(({ count }) => count)).toEqual([null, null]);
  });

  it("say when GitHub won't show a repository, until it does", () => {
    const access = (held: Held) =>
      model(reads({ app: held })).repositories[0]?.noAccess;
    expect(access(failing("notFound"))).toBe(true);
    expect(access(failing("ssoRequired", { url: "https://x" }))).toBe(true);
    expect(access(failing("gitHubFailed", { httpStatus: 403 }))).toBe(true);
    expect(access(failing("gitHubFailed", { httpStatus: 502 }))).toBe(false);
    expect(access({ ...holds(), ...failing("notFound") })).toBe(false);
  });

  it("count what waits over every repository for the badge", () => {
    expect(waiting(listed, readOf)).toBe(2);
    expect(waiting(listed, reads({ app: holds() }))).toBe(0);
    expect(waiting(listed, reads({}))).toBeNull();
    expect(waitingText(1)).toBe("1 needs your review");
    expect(waitingText(3)).toBe("3 need your review");
  });
});

describe("the labels", () => {
  const readOf = reads({
    app: holds(
      pull(1, { labels: labels("deps", "ui") }),
      pull(2, { labels: labels("Deps") }),
    ),
    site: holds(pull(3, { labels: labels("auth"), state: draft }), pull(4)),
  });
  const shown = (choices?: Partial<Choices>) =>
    model(readOf, choices).labels.map(({ name, count, chosen }) => [
      name,
      count,
      chosen,
    ]);

  it("are the view's, by count and then name", () => {
    expect(shown()).toEqual([
      ["deps", 2, false],
      ["auth", 1, false],
      ["ui", 1, false],
    ]);
    expect(shown({ view: "drafts" })).toEqual([["auth", 1, false]]);
  });

  it("keep a chosen label the view has no row for, so it can be let go", () => {
    expect(shown({ view: "drafts", labels: new Set(["ui"]) })).toEqual([
      ["auth", 1, false],
      ["ui", 0, true],
    ]);
  });

  it("match any of the chosen ones, in any letter case", () => {
    expect(numbers(readOf, { labels: new Set(["deps"]) })).toEqual([1, 2]);
    expect(numbers(readOf, { labels: new Set(["deps", "auth"]) })).toEqual([
      1, 2, 3,
    ]);
  });
});

describe("the filters", () => {
  const readOf = reads({
    app: holds(
      pull(128, {
        title: "Review a Replay",
        author: "maja",
        review: "approved",
        checks: { ...none, passed: 2 },
      }),
      pull(12, { head: "fix/sync-stall", checks: { ...none, failed: 1 } }),
      pull(7, {
        author: null,
        reviewRequested: true,
        checks: { ...none, running: 1 },
      }),
      pull(5, { review: "required", checks: null }),
    ),
  });

  it.each([
    [{ query: "replay" }, [128]],
    [{ query: " REPLAY " }, [128]],
    [{ query: "12" }, [128, 12]],
    [{ query: "#12" }, [128, 12]],
    [{ query: "#128" }, [128]],
    [{ query: "sync-" }, [12]],
    [{ query: "Maja" }, [128]],
    [{ query: "ghost" }, [7]],
    [{ author: "maja" }, [128]],
    [{ author: "ghost" }, [7]],
    [{ review: "approved" }, [128]],
    [{ review: "yours" }, [7]],
    [{ review: "required" }, [5]],
    [{ review: "none" }, [12]],
    [{ checks: "passed" }, [128]],
    [{ checks: "failing" }, [12]],
    [{ checks: "running" }, [7]],
    [{ checks: "none" }, "noMatches"],
    [{ query: "replay", author: "hubot" }, "noMatches"],
  ] as [Partial<Choices>, number[] | string][])("%o leave %o", (is, shown) => {
    expect(numbers(readOf, is)).toEqual(shown);
  });

  it("say how much of the view is left", () => {
    expect(model(readOf, { query: "12" }).scope).toBe(
      "2 of 4 pull requests across 1 of 2 repositories",
    );
  });

  it("offer the view's authors, and a chosen one it does not have", () => {
    expect(model(readOf).authors).toEqual(["ghost", "hubot", "maja"]);
    expect(model(readOf, { author: "sara" }).authors).toContain("sara");
  });

  it("match nothing when no repository is checked", () => {
    expect(numbers(readOf, { unchecked: new Set([app.key, site.key]) })).toBe(
      "noMatches",
    );
  });
});

describe("the order", () => {
  const day = (date: number) =>
    `2026-11-${String(date).padStart(2, "0")}T00:00:00Z`;
  const readOf = reads(
    {
      app: holds(
        pull(1, { createdAt: day(1), updatedAt: day(9), comments: 2 }),
        pull(2, { createdAt: day(3), updatedAt: day(4), additions: 40 }),
      ),
      site: holds(
        pull(3, { createdAt: day(2), updatedAt: day(8), comments: 7 }),
      ),
    },
    {
      app: holds(
        pull(8, { state: merged(day(5)), updatedAt: day(9) }),
        pull(9, { state: merged(day(6)), updatedAt: day(7) }),
      ),
    },
  );

  it.each([
    ["recent", [1, 3, 2]],
    ["newest", [2, 3, 1]],
    ["oldest", [1, 3, 2]],
    ["discussed", [3, 1, 2]],
    ["largest", [2, 1, 3]],
  ] as const)("%s is %o", (sort, shown) => {
    expect(numbers(readOf, { sort })).toEqual(shown);
  });

  it("of merged pull requests is when they merged", () => {
    expect(numbers(readOf, { view: "merged" })).toEqual([9, 8]);
    expect(sortLabel("recent", "merged")).toBe("Recently merged");
    expect(sortLabel("recent", "open")).toBe("Recently updated");
    expect(sortLabel("newest", "merged")).toBe("Newest first");
  });

  it("keeps each repository's rows together when grouped", () => {
    const { body } = model(readOf, { grouped: true });
    expect(
      body.kind === "rows" &&
        body.groups.map(({ repository, rows }) => [
          repository?.name,
          rows.map((row) => row.pull.number),
        ]),
    ).toEqual([
      ["app", [1, 2]],
      ["site", [3]],
    ]);
  });
});

describe("a list GitHub cut short", () => {
  const readOf = reads({
    app: { value: { items: [pull(1)], total: 1_133 } },
    site: holds(pull(2, { reviewRequested: true })),
  });
  const cut = "Newest 1 of 1,133 in app";

  it("says so at the end, or at the end of its group", () => {
    expect(model(readOf).cuts).toEqual([cut]);
    const grouped = model(readOf, { grouped: true });
    expect(grouped.cuts).toEqual([]);
    expect(
      grouped.body.kind === "rows" && grouped.body.groups.map(({ cut }) => cut),
    ).toEqual([cut, null]);
  });

  it("says so in every view of it, with or without rows, unless it is unchecked", () => {
    expect(model(readOf, { view: "drafts" }).cuts).toEqual([cut]);
    expect(model(readOf, { view: "review", grouped: true }).cuts).toEqual([
      cut,
    ]);
    expect(model(readOf, { view: "merged" }).cuts).toEqual([]);
    expect(model(readOf, { unchecked: new Set([app.key]) }).cuts).toEqual([]);
  });

  it("never claims to show everything that waits", () => {
    const everything = (choices: Partial<Choices>) => {
      const { body } = model(readOf, { view: "review", ...choices });
      return body.kind === "rows" && body.everything;
    };
    expect(everything({})).toBe(false);
    expect(everything({ unchecked: new Set([app.key]) })).toBe(true);
    expect(everything({ unchecked: new Set([app.key]), view: "open" })).toBe(
      false,
    );
  });
});

describe("without rows", () => {
  const body = (open: Record<string, Held>, choices?: Partial<Choices>) =>
    model(reads(open), choices).body;

  it("is loading until every repository answered or failed", () => {
    expect(body({})).toEqual({ kind: "loading" });
    expect(body({ app: holds(), site: { reading: true } })).toEqual({
      kind: "loading",
    });
    expect(body({ app: holds() })).toEqual({ kind: "loading" });
    expect(model(reads({})).scope).toBe("Reading 2 repositories…");
  });

  it("shows the first rows while others are still read", () => {
    expect(body({ app: holds(pull(1)), site: { reading: true } }).kind).toBe(
      "rows",
    );
  });

  it("says nothing is there once all answered", () => {
    expect(body({ app: holds(), site: holds() })).toEqual({
      kind: "nothing",
      title: "Nothing open",
      detail: "No pull request is open in 2 repositories.",
    });
    expect(body({ app: holds(), site: failing("notFound") })).toMatchObject({
      detail: "No pull request is open in 1 of 2 repositories.",
    });
  });

  it("claims nothing when no repository could be read", () => {
    expect(
      body({ app: failing("notFound"), site: failing("notFound") }),
    ).toEqual({ kind: "unread" });
    expect(body({ app: failing("keychain") })).toEqual({ kind: "unread" });
    expect(model(reads({ app: failing("keychain") })).scope).toBe("");
  });

  it("still loads when a failed repository is read again", () => {
    expect(
      body({
        app: { ...failing("unreachable"), reading: true },
        site: failing("unreachable"),
      }).kind,
    ).toBe("loading");
  });
});

describe("the notices", () => {
  const three = [app, site, api];
  const told = (open: Record<string, Held>, choices?: Partial<Choices>) =>
    notices(three, reads(open), choose(choices));

  it("are none while every read works", () => {
    expect(told({ app: holds(), site: { reading: true } })).toEqual([]);
  });

  it("say offline, and the last success, once no repository could be reached", () => {
    const unreachable = failing("unreachable");
    expect(
      told({
        app: { ...holds(), at: 1_000, ...unreachable },
        site: { ...holds(), at: 5_000, ...failing("transport") },
        api: failing("unanswered"),
      }),
    ).toEqual([{ kind: "offline", at: 5_000 }]);
    expect(
      told({
        app: unreachable,
        site: { reading: true },
        api: { reading: true },
      }),
    ).toEqual([{ kind: "offline", at: null }]);
  });

  it("name the one repository GitHub did not answer for, when it answered for others", () => {
    expect(
      told({ app: holds(), site: failing("unreachable"), api: holds() }),
    ).toEqual([
      {
        kind: "repository",
        repository: site,
        message: "unreachable.",
        authorize: null,
      },
    ]);
  });

  it("say where single sign-on is authorized", () => {
    const url = "https://github.com/orgs/octo/sso";
    expect(
      told({ app: holds(), site: failing("ssoRequired", { url }) }),
    ).toMatchObject([{ kind: "repository", repository: site, authorize: url }]);
  });

  it("say what is true of the connection once", () => {
    const limited = failing("rateLimited", { resetAt: 9 });
    expect(
      told({ app: limited, site: limited, api: failing("notFound") }),
    ).toMatchObject([
      { kind: "connection", message: "rateLimited." },
      { kind: "repository", repository: api },
    ]);
  });

  it("say the hourly limit once, though its minutes tick between reads", () => {
    expect(
      told({
        app: failing("rateLimited", { message: "In 25 minutes.", resetAt: 9 }),
        site: failing("rateLimited", { message: "In 24 minutes.", resetAt: 9 }),
      }),
    ).toEqual([{ kind: "connection", message: "In 24 minutes." }]);
  });

  it("name three repositories and count the rest", () => {
    const many = ["a", "b", "c", "d", "e"].map(repository);
    expect(
      notices(
        many,
        reads(
          Object.fromEntries(
            many.map(({ name }) => [name, failing("notFound")]),
          ),
        ),
        choose(),
      ).map((notice) =>
        notice.kind === "repository" ? notice.repository.name : notice,
      ),
    ).toEqual(["a", "b", "c", { kind: "more", count: 2 }]);
  });

  it("leave out an unchecked repository and the list that is not shown", () => {
    const open = { app: failing("notFound") };
    expect(told(open, { unchecked: new Set([app.key]) })).toEqual([]);
    expect(told(open, { view: "merged" })).toEqual([]);
  });
});
