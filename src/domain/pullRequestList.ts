import type { OverviewView } from "../overview";
import type { Read } from "../pullRequests";
import type { HostProblem } from "./host";
import type {
  PullRequestList,
  PullRequests,
  PullRequestSummary,
} from "./pullRequest";
import type { GitHubRepository, RepositoryRoot } from "./repository";
import { distinctNames } from "./repositoryNames";
import { normalizeSearch } from "./search";

export type ListedRepository = {
  key: string;
  /** What the sidebar calls the first saved repository with these pull requests. */
  name: string;
  /** That repository's. */
  root: RepositoryRoot;
  github: GitHubRepository;
};

export type SavedRepositories = {
  listed: readonly ListedRepository[];
  /** How many saved repositories aren't on GitHub. */
  elsewhere: number;
  /** Whether some saved repository has not said yet where it is. */
  opening: boolean;
};

export function savedRepositories(
  entries: readonly { root: RepositoryRoot; name: string }[],
  { roots, repositories }: Pick<OverviewView, "roots" | "repositories">,
): SavedRepositories {
  const suffixes = distinctNames(entries);
  const listed = new Map<string, ListedRepository>();
  let elsewhere = 0;
  let opening = false;
  for (const { root, name } of entries) {
    const state = roots.get(root);
    if (state === undefined || state.kind === "opening") opening = true;
    if (state?.kind !== "open") continue;
    const github = repositories.find(
      ({ commonDir }) => commonDir === state.commonDir,
    )?.overview.github;
    if (!github) {
      elsewhere += 1;
      continue;
    }
    const key = `${github.owner}/${github.repo}`.toLowerCase();
    const suffix = suffixes.get(root);
    if (!listed.has(key))
      listed.set(key, {
        key,
        name: suffix ? `${name} ${suffix}` : name,
        root,
        github,
      });
  }
  return { listed: [...listed.values()], elsewhere, opening };
}

export const pullRequestUrl = (
  { owner, repo }: GitHubRepository,
  number: number,
) => `https://github.com/${owner}/${repo}/pull/${number}`;

export const authorName = ({ author }: Pick<PullRequestSummary, "author">) =>
  author ?? "ghost";

export const stateLabels = {
  draft: "Draft",
  failing: "Checks failing",
  running: "Checks running",
  ready: "Ready to merge",
  open: "Open",
  merged: "Merged",
  closed: "Closed",
} as const;
export type RowState = keyof typeof stateLabels;

/** The first state that applies wins. */
export function rowState({
  state,
  checks,
  mergeable,
  review,
}: Pick<
  PullRequestSummary,
  "state" | "checks" | "mergeable" | "review"
>): RowState {
  if (state.kind !== "open") return state.kind;
  if (state.draft) return "draft";
  if (checks && checks.failed > 0) return "failing";
  if (checks && checks.running > 0) return "running";
  const met = review === null || review === "approved";
  return checks && met && mergeable === "mergeable" ? "ready" : "open";
}

export const reviewLabels = {
  yours: "Your review",
  approved: "Approved",
  changesRequested: "Changes requested",
  required: "Review required",
  draft: "Draft",
} as const;
export type ReviewPill = keyof typeof reviewLabels;

/** What the review asks of the viewer, or null when it asks for nothing. */
export function reviewPill({
  state,
  reviewRequested,
  review,
}: Pick<
  PullRequestSummary,
  "state" | "reviewRequested" | "review"
>): ReviewPill | null {
  if (state.kind === "open" && state.draft) return "draft";
  return reviewRequested ? "yours" : review;
}

type ChecksKind = "passed" | "failing" | "running" | "none" | "noAccess";
export type Checks = { kind: ChecksKind; label: string };

/** Skipped checks neither pass nor fail, so they don't count. */
export function checksOf({
  checks,
}: Pick<PullRequestSummary, "checks">): Checks {
  if (checks === null) return { kind: "noAccess", label: "No access" };
  const { passed, failed, running } = checks;
  const total = passed + failed + running;
  if (failed > 0) return { kind: "failing", label: `${failed} failing` };
  if (running > 0) return { kind: "running", label: `${passed} of ${total}` };
  if (total > 0) return { kind: "passed", label: `${passed}/${total}` };
  return { kind: "none", label: "–" };
}

export const changeSegments = 5;

/** How many of the bar's segments are added lines. Null when nothing changed. */
export function addedSegments({
  additions,
  deletions,
}: Pick<PullRequestSummary, "additions" | "deletions">): number | null {
  const total = additions + deletions;
  return total === 0 ? null : Math.round((changeSegments * additions) / total);
}

/** When the row last changed, or when it merged. */
export const rowTime = ({
  state,
  updatedAt,
}: Pick<PullRequestSummary, "state" | "updatedAt">) =>
  state.kind === "merged" ? state.at : updatedAt;

const isDraft = ({ state }: PullRequestSummary) =>
  state.kind === "open" && state.draft;

export const viewLabels = {
  open: "All open",
  review: "Needs your review",
  mine: "Created by you",
  drafts: "Drafts",
  merged: "Recently merged",
} as const;
export type View = keyof typeof viewLabels;
export const views = Object.keys(viewLabels) as View[];

const inView: Record<View, (pull: PullRequestSummary) => boolean> = {
  open: () => true,
  review: (pull) => pull.reviewRequested && !isDraft(pull),
  mine: (pull) => pull.viewerIsAuthor,
  drafts: isDraft,
  merged: () => true,
};

export const listOf = (view: View): PullRequestList =>
  view === "merged" ? "recentlyMerged" : "open";

const sortLabels = {
  recent: "Recently updated",
  newest: "Newest first",
  oldest: "Oldest first",
  discussed: "Most discussed",
  largest: "Largest change",
} as const;
export type Sort = keyof typeof sortLabels;
export const sorts = Object.keys(sortLabels) as Sort[];

export const sortLabel = (sort: Sort, view: View) =>
  sort === "recent" && view === "merged" ? viewLabels.merged : sortLabels[sort];

const latest = (left: string, right: string) =>
  Date.parse(right) - Date.parse(left);
const size = ({ additions, deletions }: PullRequestSummary) =>
  additions + deletions;
const order: Record<
  Sort,
  (left: PullRequestSummary, right: PullRequestSummary) => number
> = {
  recent: (left, right) => latest(rowTime(left), rowTime(right)),
  newest: (left, right) => latest(left.createdAt, right.createdAt),
  oldest: (left, right) => latest(right.createdAt, left.createdAt),
  discussed: (left, right) => right.comments - left.comments,
  largest: (left, right) => size(right) - size(left),
};

export type ReviewFilter = Exclude<ReviewPill, "draft"> | "none";
export const reviewFilters: Record<ReviewFilter, string> = {
  yours: reviewLabels.yours,
  approved: reviewLabels.approved,
  changesRequested: reviewLabels.changesRequested,
  required: reviewLabels.required,
  none: "No review",
};
export type ChecksFilter = Exclude<ChecksKind, "noAccess">;
export const checksFilters: Record<ChecksFilter, string> = {
  passed: "Passed",
  failing: "Failing",
  running: "Running",
  none: "No checks",
};

type Filters = {
  query: string;
  labels: ReadonlySet<string>;
  author: string | null;
  review: ReviewFilter | null;
  checks: ChecksFilter | null;
};
export const noFilters: Filters = {
  query: "",
  labels: new Set(),
  author: null,
  review: null,
  checks: null,
};

export type Choices = Filters & {
  view: View;
  /** The keys of the repositories left out. A repository added later starts checked. */
  unchecked: ReadonlySet<string>;
  sort: Sort;
  grouped: boolean;
};
export const initialChoices: Choices = {
  ...noFilters,
  view: "open",
  unchecked: new Set(),
  sort: "recent",
  grouped: false,
};

const labelKey = (name: string) => name.toLowerCase();

function matching(filters: Filters): (pull: PullRequestSummary) => boolean {
  const { labels, author, review, checks } = filters;
  const needle = normalizeSearch(filters.query.trim());
  return (pull) =>
    (labels.size === 0 ||
      pull.labels.items.some(({ name }) => labels.has(labelKey(name)))) &&
    (author === null || authorName(pull) === author) &&
    (review === null || (reviewPill(pull) ?? "none") === review) &&
    (checks === null || checksOf(pull).kind === checks) &&
    (needle === "" ||
      normalizeSearch(
        `${pull.title}\0#${pull.number}\0${pull.head}\0${authorName(pull)}`,
      ).includes(needle));
}

export type Row = {
  key: string;
  repository: ListedRepository;
  pull: PullRequestSummary;
};

type LabelChoice = {
  key: string;
  name: string;
  /** Six hex digits, or null for a chosen label that no row in the view has. */
  color: string | null;
  count: number;
  chosen: boolean;
};

function labelChoices(
  rows: readonly Row[],
  chosen: ReadonlySet<string>,
): LabelChoice[] {
  const found = new Map<string, LabelChoice>();
  for (const { pull } of rows)
    for (const { name, color } of pull.labels.items) {
      const key = labelKey(name);
      const label = found.get(key);
      if (label) label.count += 1;
      else
        found.set(key, { key, name, color, count: 1, chosen: chosen.has(key) });
    }
  for (const key of chosen)
    if (!found.has(key))
      found.set(key, { key, name: key, color: null, count: 0, chosen: true });
  return [...found.values()].sort(
    (left, right) =>
      right.count - left.count || left.name.localeCompare(right.name),
  );
}

type ListRead = Read<PullRequests>;
export type ReadOf = (
  repository: ListedRepository,
  list: PullRequestList,
) => ListRead;

const things = (count: number, one: string, many: string) =>
  `${count.toLocaleString()} ${count === 1 ? one : many}`;
const repositories = (count: number) =>
  things(count, "repository", "repositories");

const scopes: Record<
  View,
  (amount: (one: string, many: string) => string, across: string) => string
> = {
  open: (amount, across) =>
    `${amount("pull request", "pull requests")} across ${across}`,
  review: (amount) =>
    `${amount("pull request", "pull requests")} waiting on you`,
  mine: (amount, across) =>
    `${amount("pull request", "pull requests")} across ${across}`,
  drafts: (amount, across) => `${amount("draft", "drafts")} across ${across}`,
  merged: (amount) => `${amount("merged", "merged")} in the last 7 days`,
};

const nothings: Record<
  View,
  { title: string; detail: (across: string) => string }
> = {
  open: {
    title: "Nothing open",
    detail: (across) => `No pull request is open in ${across}.`,
  },
  review: {
    title: "Nothing waiting on you",
    detail: () =>
      "A pull request shows up here when someone asks for your review.",
  },
  mine: {
    title: "Nothing created by you",
    detail: (across) => `You have no open pull request in ${across}.`,
  },
  drafts: {
    title: "No drafts",
    detail: (across) => `No draft is open in ${across}.`,
  },
  merged: {
    title: "Nothing merged",
    detail: (across) =>
      `No pull request merged in ${across} in the last 7 days.`,
  },
};

export type Group = {
  /** Null for the one group of a list that is not grouped. */
  repository: ListedRepository | null;
  rows: readonly Row[];
  cut: string | null;
};

export type ListModel = {
  counts: Record<View, number | null>;
  repositories: readonly {
    repository: ListedRepository;
    checked: boolean;
    /** Null until its list was read. */
    count: number | null;
    /** GitHub won't show this sign-in the repository. */
    noAccess: boolean;
  }[];
  labels: readonly LabelChoice[];
  authors: readonly string[];
  scope: string;
  /** "Newest 50 of 133 in jest", for each repository cut short that no group says it of. */
  cuts: readonly string[];
  body:
    | { kind: "loading" }
    | { kind: "unread" }
    | { kind: "nothing"; title: string; detail: string }
    | { kind: "noMatches" }
    | { kind: "rows"; groups: readonly Group[]; everything: boolean };
};

export function listModel(
  listed: readonly ListedRepository[],
  readOf: ReadOf,
  choices: Choices,
): ListModel {
  const { view, unchecked, sort, grouped } = choices;
  const checked = listed.filter(({ key }) => !unchecked.has(key));
  const reads = checked.map((repository) => ({
    repository,
    read: readOf(repository, listOf(view)),
  }));
  const rowsIn = (repository: ListedRepository, of: View): Row[] | null =>
    readOf(repository, listOf(of))
      .value?.items.filter(inView[of])
      .map((pull) => ({
        key: `${repository.key}#${pull.number}`,
        repository,
        pull,
      })) ?? null;
  const count = (of: View) => {
    const each = checked.flatMap((repository) => rowsIn(repository, of) ?? []);
    return checked.some((repository) => rowsIn(repository, of) !== null)
      ? each.length
      : null;
  };

  const all = checked.flatMap((repository) => rowsIn(repository, view) ?? []);
  const matches = matching(choices);
  const rows = all
    .filter(({ pull }) => matches(pull))
    .sort(
      (left, right) =>
        order[sort](left.pull, right.pull) ||
        order.recent(left.pull, right.pull),
    );
  const sections = reads.map(
    ({ repository, read: { value } }): Group => ({
      repository,
      rows: rows.filter((row) => row.repository === repository),
      cut:
        value && value.items.length < value.total
          ? `Newest ${value.items.length.toLocaleString()} of ${value.total.toLocaleString()} in ${repository.name}`
          : null,
    }),
  );
  const groups = grouped
    ? sections.filter((section) => section.rows.length > 0)
    : [];
  const cuts = sections.flatMap((section) =>
    section.cut === null || groups.includes(section) ? [] : [section.cut],
  );
  const answered = reads.filter(({ read }) => read.value !== null);
  const across =
    answered.length < checked.length
      ? `${answered.length.toLocaleString()} of ${repositories(checked.length)}`
      : repositories(checked.length);

  function body(): ListModel["body"] {
    if (rows.length > 0)
      return {
        kind: "rows",
        groups: grouped ? groups : [{ repository: null, rows, cut: null }],
        everything:
          view === "review" &&
          rows.length === all.length &&
          reads.every(
            ({ read }) => read.value !== null && read.problem === null,
          ) &&
          sections.every(({ cut }) => cut === null),
      };
    if (all.length > 0 || checked.length === 0) return { kind: "noMatches" };
    const stopped = reads.some(({ read: { problem } }) =>
      problem ? shared(problem) : false,
    );
    const pending = reads.some(
      ({ read: { value, reading, problem } }) =>
        value === null && (reading || (problem === null && !stopped)),
    );
    if (pending) return { kind: "loading" };
    if (answered.length === 0) return { kind: "unread" };
    const { title, detail } = nothings[view];
    return { kind: "nothing", title, detail: detail(across) };
  }
  const shown = body();
  const authors = new Set(all.map(({ pull }) => authorName(pull)));
  if (choices.author !== null) authors.add(choices.author);

  return {
    counts: {
      open: count("open"),
      review: count("review"),
      mine: count("mine"),
      drafts: count("drafts"),
      merged: count("merged"),
    },
    repositories: listed.map((repository) => {
      const { value, problem } = readOf(repository, listOf(view));
      const isChecked = !unchecked.has(repository.key);
      const own = rowsIn(repository, view);
      return {
        repository,
        checked: isChecked,
        count: own && (isChecked ? own.length : 0),
        noAccess: value === null && problem !== null && withheld(problem),
      };
    }),
    labels: labelChoices(all, choices.labels),
    authors: [...authors].sort((left, right) => left.localeCompare(right)),
    cuts,
    scope:
      shown.kind === "loading"
        ? `Reading ${repositories(checked.length)}…`
        : answered.length === 0
          ? ""
          : scopes[view](
              (one, many) =>
                rows.length < all.length
                  ? `${rows.length.toLocaleString()} of ${things(all.length, one, many)}`
                  : things(all.length, one, many),
              across,
            ),
    body: shown,
  };
}

/** Every open pull request that waits for the viewer, or null when no list was read. */
export function waiting(
  listed: readonly ListedRepository[],
  readOf: ReadOf,
): number | null {
  const lists = listed.flatMap(
    (repository) => readOf(repository, "open").value ?? [],
  );
  return lists.length === 0
    ? null
    : lists.flatMap(({ items }) => items).filter(inView.review).length;
}

export const waitingText = (count: number) =>
  `${count.toLocaleString()} ${count === 1 ? "needs" : "need"} your review`;

export const elsewhereText = (count: number) =>
  count === 1
    ? "1 saved repository isn't on GitHub."
    : `${count.toLocaleString()} saved repositories aren't on GitHub.`;

const withheld = (problem: HostProblem) =>
  problem.kind === "notFound" ||
  problem.kind === "ssoRequired" ||
  (problem.kind === "gitHubFailed" && problem.httpStatus === 403);

/** For a read, a question GitHub never answered is as good as one never sent. */
export const offline = ({ kind }: HostProblem) =>
  kind === "unreachable" || kind === "unanswered" || kind === "transport";

/** These come from the connection, so every repository would say the same. */
const shared = ({ kind }: HostProblem) =>
  kind === "rateLimited" || kind === "keychain";

export type Notice =
  | { kind: "offline"; at: number | null }
  | { kind: "connection"; message: string }
  | {
      kind: "repository";
      repository: ListedRepository;
      message: string;
      /** Where single sign-on is authorized. */
      authorize: string | null;
    }
  | { kind: "more"; count: number };

const shownProblems = 3;

export function notices(
  listed: readonly ListedRepository[],
  readOf: ReadOf,
  { view, unchecked }: Pick<Choices, "view" | "unchecked">,
): Notice[] {
  const reads = listed
    .filter(({ key }) => !unchecked.has(key))
    .map((repository) => ({
      repository,
      read: readOf(repository, listOf(view)),
    }));
  const failed = reads.flatMap(({ repository, read: { problem } }) =>
    problem ? [{ repository, problem }] : [],
  );
  if (failed.length === 0) return [];
  if (
    reads.every(({ read }) =>
      read.problem ? offline(read.problem) : read.reading,
    )
  ) {
    const times = reads.flatMap(({ read: { at } }) =>
      at === null ? [] : [at],
    );
    return [
      { kind: "offline", at: times.length > 0 ? Math.max(...times) : null },
    ];
  }
  const connection = new Map(
    failed.flatMap(({ problem }) =>
      shared(problem) ? [[problem.kind, problem.message] as const] : [],
    ),
  );
  const own = failed.filter(({ problem }) => !shared(problem));
  const rest = own.length - shownProblems;
  return [
    ...[...connection.values()].map(
      (message): Notice => ({ kind: "connection", message }),
    ),
    ...own.slice(0, shownProblems).map(
      ({ repository, problem }): Notice => ({
        kind: "repository",
        repository,
        message: problem.message,
        authorize: problem.kind === "ssoRequired" ? problem.url : null,
      }),
    ),
    ...(rest > 0 ? [{ kind: "more", count: rest } satisfies Notice] : []),
  ];
}
