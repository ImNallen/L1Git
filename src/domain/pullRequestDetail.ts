import type { Read } from "../pullRequests";
import type {
  PullRequest,
  PullRequestSummary,
  ReviewState,
  ReviewThread,
  TimelineEvent,
} from "./pullRequest";
import { offline } from "./pullRequestList";
import type { ListedRepository, Notice } from "./pullRequestList";
import { shortOid } from "./shortOid";

/** Why what is shown may be old, or null. */
export function detailNotice(
  { value, at, problem }: Read<PullRequest>,
  repository: ListedRepository,
): Notice | null {
  if (value === null || problem === null) return null;
  if (offline(problem)) return { kind: "offline", at };
  const { message } = problem;
  return problem.kind === "ssoRequired"
    ? { kind: "repository", repository, message, authorize: problem.url }
    : { kind: "connection", message };
}

type EventOf<Kind extends TimelineEvent["kind"]> = Extract<
  TimelineEvent,
  { kind: Kind }
>;

export const counted = (count: number, one: string, many = `${one}s`) =>
  `${count.toLocaleString()} ${count === 1 ? one : many}`;

const isLogin = (login: string | null, other: string | null) =>
  login !== null &&
  other !== null &&
  login.toLowerCase() === other.toLowerCase();

/** GitHub calls a deleted account ghost. */
export const personName = (login: string | null, viewer: string | null) =>
  isLogin(login, viewer) ? "You" : (login ?? "ghost");

/** "Your", or "sara's", before a noun. */
export const whose = (login: string | null, viewer: string | null) =>
  isLogin(login, viewer) ? "Your" : `${login ?? "ghost"}'s`;

/** "a", "a and b", "a, b and 2 more". */
export function named(names: readonly string[]): string {
  const shown = names.slice(0, names.length > 3 ? 2 : 3);
  const rest = names.length - shown.length;
  const all = rest > 0 ? [...shown, `${rest.toLocaleString()} more`] : shown;
  return all.length < 2
    ? (all[0] ?? "")
    : `${all.slice(0, -1).join(", ")} and ${all.at(-1)}`;
}

export type PullState = "open" | "draft" | "merged" | "closed";
export const pullState = ({
  state,
}: Pick<PullRequestSummary, "state">): PullState =>
  state.kind === "open" && state.draft ? "draft" : state.kind;

export const mergedEvent = ({ timeline }: PullRequest) =>
  timeline.items.find((event) => event.kind === "merged") ?? null;

/** What the header says before the branches. `pull` is null until it was read. */
export function headline(
  summary: Pick<PullRequestSummary, "state" | "author" | "viewerIsAuthor">,
  pull: PullRequest | null,
  viewer: string | null,
): string {
  const author = summary.viewerIsAuthor
    ? "You"
    : personName(summary.author, viewer);
  const commits = pull ? ` ${counted(pull.commits.total, "commit")}` : "";
  switch (summary.state.kind) {
    case "open":
      return `${author} ${author === "You" ? "want" : "wants"} to merge${commits} into`;
    case "merged": {
      const merged = pull && mergedEvent(pull);
      return merged
        ? `${personName(merged.by, viewer)} merged${commits} into`
        : `Merged${commits} into`;
    }
    case "closed":
      return `${author} wanted to merge${commits} into`;
    default: {
      const exhaustive: never = summary.state;
      return exhaustive;
    }
  }
}

/** "owner:branch" for a branch of another repository. */
export const headName = ({ head }: Pick<PullRequest, "head">) =>
  head.crossRepository && head.repository !== null
    ? `${head.repository.owner}:${head.branch}`
    : head.branch;

/** GitHub answers with the newest 100 of a timeline. */
const TIMELINE_ASKED = 100;

/** What the timeline leaves out, or null when it is whole. */
export function leftOut({ timeline }: Pick<PullRequest, "timeline">) {
  if (timeline.items.length >= timeline.total) return null;
  return timeline.total > TIMELINE_ASKED
    ? "Earlier activity isn't shown."
    : "Some activity isn't shown.";
}

/** "31 of 140 review threads are shown." */
export function threadsLeftOut({
  threads,
}: Pick<PullRequest, "threads">): string | null {
  if (threads === null || threads.items.length >= threads.total) return null;
  return `${threads.items.length.toLocaleString()} of ${threads.total.toLocaleString()} review threads are shown.`;
}

/** Comments, reviews with words, and everything said in threads. */
export function conversationCount(
  pull: Pick<PullRequest, "timeline" | "threads">,
): string {
  const spoken = pull.timeline.items.filter(
    (event) =>
      event.kind === "comment" ||
      (event.kind === "review" && event.body.trim() !== ""),
  ).length;
  const inThreads = (pull.threads?.items ?? []).reduce(
    (sum, { comments }) => sum + comments.total,
    0,
  );
  const partial =
    pull.threads === null ||
    leftOut(pull) !== null ||
    threadsLeftOut(pull) !== null;
  return `${(spoken + inThreads).toLocaleString()}${partial ? "+" : ""}`;
}

type Happened = { key: string; by: string | null; at: string };
export type Entry = Happened &
  (
    | { kind: "commits"; commits: readonly EventOf<"commit">[] }
    | { kind: "comment"; body: string }
    | {
        kind: "review";
        state: ReviewState;
        body: string;
        threads: readonly ReviewThread[];
      }
    | { kind: "thread"; thread: ReviewThread }
    | {
        kind: "event";
        event: Exclude<TimelineEvent, EventOf<"commit" | "comment">>;
      }
  );

/** The conversation in GitHub's order, with commits folded and threads placed. */
export function conversation({
  timeline,
  threads,
}: Pick<PullRequest, "timeline" | "threads">): Entry[] {
  const listed = new Set(
    timeline.items.flatMap((event) =>
      event.kind === "review" ? [event.id] : [],
    ),
  );
  const byReview = new Map<string, ReviewThread[]>();
  const loose: ReviewThread[] = [];
  for (const thread of threads?.items ?? [])
    if (thread.review !== null && listed.has(thread.review))
      byReview.set(thread.review, [
        ...(byReview.get(thread.review) ?? []),
        thread,
      ]);
    else loose.push(thread);
  const mergedAt = new Set(
    timeline.items.flatMap((event) =>
      event.kind === "merged" ? [event.at] : [],
    ),
  );

  const entries: Entry[] = [];
  for (const event of timeline.items) {
    const { id: key, by, at } = event;
    const happened = { key, by, at };
    switch (event.kind) {
      case "commit": {
        const last = entries.at(-1);
        if (last?.kind === "commits" && last.by === by)
          entries[entries.length - 1] = {
            ...last,
            at,
            commits: [...last.commits, event],
          };
        else
          entries.push({
            ...happened,
            kind: "commits",
            commits: [event],
          });
        break;
      }
      case "comment":
        entries.push({ ...happened, kind: "comment", body: event.body });
        break;
      case "review": {
        const own = byReview.get(event.id) ?? [];
        const says = event.body.trim() !== "";
        if (says || own.length > 0)
          entries.push({
            ...happened,
            kind: "review",
            state: event.state,
            body: event.body,
            threads: own,
          });
        else if (event.state !== "commented")
          entries.push({ ...happened, kind: "event", event });
        break;
      }
      case "closed":
        // A merge closes the pull request too, which says nothing more.
        if (!mergedAt.has(at))
          entries.push({ ...happened, kind: "event", event });
        break;
      default:
        entries.push({ ...happened, kind: "event", event });
    }
  }

  for (const thread of loose) {
    const first = thread.comments.items[0];
    const entry: Entry = {
      key: thread.id,
      by: first?.by ?? null,
      at: first?.at ?? entries.at(-1)?.at ?? "",
      kind: "thread",
      thread,
    };
    // A rebased commit keeps its place under an old date, so only a later entry says where.
    const next = first
      ? entries.findIndex(({ at }) => Date.parse(at) > Date.parse(first.at))
      : -1;
    entries.splice(next < 0 ? entries.length : next, 0, entry);
  }
  return entries;
}

/** What an event line says after the name of who did it. */
export function eventText(
  event: Extract<Entry, { kind: "event" }>["event"],
  { base, head }: Pick<PullRequest, "base" | "head">,
): string {
  switch (event.kind) {
    case "review":
      return reviewVerbs[event.state];
    case "forcePushed":
      if (event.to === null) return "force-pushed this branch";
      return event.from === null
        ? `force-pushed to ${shortOid(event.to)}`
        : `force-pushed ${shortOid(event.from)}..${shortOid(event.to)}`;
    case "merged":
      return event.oid === null
        ? `merged this into ${base}`
        : `merged ${shortOid(event.oid)} into ${base}`;
    case "closed":
      return "closed this";
    case "reopened":
      return "reopened this";
    case "branchDeleted":
      return `deleted ${head.branch}`;
    case "readyForReview":
      return "marked this as ready for review";
    case "convertedToDraft":
      return "marked this as a draft";
    case "baseChanged":
      return `changed the base from ${event.from} to ${event.to}`;
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

const reviewVerbs: Record<ReviewState, string> = {
  requested: "was asked for a review",
  approved: "approved these changes",
  changesRequested: "requested changes",
  dismissed: "left a review that was dismissed",
  commented: "reviewed",
};

export const reviewStateLabels: Record<ReviewState, string> = {
  requested: "Waiting",
  approved: "Approved",
  changesRequested: "Changes requested",
  dismissed: "Dismissed",
  commented: "Commented",
};

export function reviewers(
  pull: Pick<PullRequest, "reviewers">,
  viewer: string | null,
) {
  return pull.reviewers.map(({ login, state }) => ({
    login,
    name: login === null ? "A team" : personName(login, viewer),
    state,
    label:
      state === "requested" && isLogin(login, viewer)
        ? "Waiting on you"
        : reviewStateLabels[state],
  }));
}

export function lineLabel({
  line,
  startLine,
  originalLine,
  originalStartLine,
}: Pick<
  ReviewThread,
  "line" | "startLine" | "originalLine" | "originalStartLine"
>): string {
  const [end, start] =
    line === null ? [originalLine, originalStartLine] : [line, startLine];
  if (end === null) return "Whole file";
  return start === null || start === end
    ? `Line ${end}`
    : `Lines ${start}–${end}`;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const FEWEST_LINES = 4;
const MOST_LINES = 12;
/** A line in two scripts takes longer. One of 10,000 took 100 ms of a frame. */
function cutLine(line: string): string {
  const most = /[^\0-\u024f]/.test(line) ? 100 : 1_000;
  return line.length > most ? `${line.slice(0, most)}…` : line;
}

export type Excerpt =
  | { kind: "diff"; patch: string }
  | { kind: "text"; text: string };

/**
 * The end of a thread's hunk, where its comment is: the commented lines, out of
 * the last four at least and the last twelve at most. Null when GitHub sent none.
 */
export function excerpt({
  hunk,
  side,
  originalLine,
  originalStartLine,
}: Pick<
  ReviewThread,
  "hunk" | "side" | "originalLine" | "originalStartLine"
>): Excerpt | null {
  if (hunk.trim() === "") return null;
  const [header = "", ...lines] = hunk.replace(/\n$/, "").split("\n");
  const found = HUNK.exec(header);
  if (
    found === null ||
    lines.length === 0 ||
    !lines.every((line) => /^(?:[ +\-\\]|\r?$)/.test(line))
  )
    return {
      kind: "text",
      text: hunk
        .trimEnd()
        .split("\n")
        .slice(-MOST_LINES)
        .map(cutLine)
        .join("\n"),
    };
  // A side without lines is named by the line before it.
  const first = (start: string | undefined, count: string | undefined) =>
    Number(start) + (count === "0" ? 1 : 0);
  let old = first(found[1], found[2]);
  let next = first(found[3], found[4]);
  const rows = lines.map((line) => {
    const onOld = !/^[+\\]/.test(line);
    const onNext = !/^[-\\]/.test(line);
    const row = { line, old, next, onOld, onNext };
    if (onOld) old += 1;
    if (onNext) next += 1;
    return row;
  });
  const from = originalStartLine ?? originalLine;
  const commented =
    from === null
      ? -1
      : rows.findIndex((row) =>
          side === "left"
            ? row.onOld && row.old >= from
            : row.onNext && row.next >= from,
        );
  const wanted =
    commented < 0
      ? FEWEST_LINES
      : Math.min(MOST_LINES, Math.max(FEWEST_LINES, rows.length - commented));
  const end = rows.slice(-wanted);
  // The mark of a missing newline says it of the line before.
  const shown = end.slice(
    Math.max(
      0,
      end.findIndex(({ line }) => !line.startsWith("\\")),
    ),
  );
  const [top] = shown;
  if (!top) return null;
  const olds = shown.filter(({ onOld }) => onOld).length;
  const nexts = shown.filter(({ onNext }) => onNext).length;
  const at = (start: number, count: number) =>
    `${count === 0 ? start - 1 : start},${count}`;
  return {
    kind: "diff",
    patch: [
      "--- a/file",
      "+++ b/file",
      `@@ -${at(top.old, olds)} +${at(top.next, nexts)} @@`,
      ...shown.map(({ line }) => (line === "" ? " " : cutLine(line))),
      "",
    ].join("\n"),
  };
}

type CommitItem =
  | { kind: "commit"; commit: PullRequest["commits"]["items"][number] }
  | { kind: "forcePushed"; event: EventOf<"forcePushed"> };
export type CommitDay = {
  key: string;
  label: string;
  commits: number;
  items: readonly CommitItem[];
};

function dayLabel(date: Date, now: Date, locale?: string): string {
  const days = Math.round(
    (new Date(now).setHours(0, 0, 0, 0) - new Date(date).setHours(0, 0, 0, 0)) /
      86_400_000,
  );
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return date.toLocaleDateString(locale, {
    weekday: "long",
    day: "numeric",
    month: "long",
    ...(date.getFullYear() !== now.getFullYear() && { year: "numeric" }),
  });
}

/** The commits by day, newest first, with each force push above what it replaced. */
export function commitDays(
  { commits, timeline }: Pick<PullRequest, "commits" | "timeline">,
  now = new Date(),
  locale?: string,
): CommitDay[] {
  const items: CommitItem[] = commits.items
    .map((commit): CommitItem => ({ kind: "commit", commit }))
    .reverse();
  const atOf = (item: CommitItem) =>
    Date.parse(item.kind === "commit" ? item.commit.at : item.event.at);
  for (const event of timeline.items) {
    if (event.kind !== "forcePushed") continue;
    const older = items.findIndex((item) => atOf(item) <= Date.parse(event.at));
    items.splice(older < 0 ? items.length : older, 0, {
      kind: "forcePushed",
      event,
    });
  }
  const days: (Omit<CommitDay, "items"> & { items: CommitItem[] })[] = [];
  for (const item of items) {
    const label = dayLabel(new Date(atOf(item)), now, locale);
    let day = days.at(-1);
    if (day?.label !== label) {
      day = { key: `${days.length} ${label}`, label, commits: 0, items: [] };
      days.push(day);
    }
    if (item.kind === "commit") day.commits += 1;
    day.items.push(item);
  }
  return days;
}
