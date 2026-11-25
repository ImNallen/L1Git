import type { Read } from "../pullRequests";
import type {
  Check,
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

const seconds = (at: string) => Date.parse(at) / 1_000;
export const counted = (count: number, one: string, many = `${one}s`) =>
  `${count.toLocaleString()} ${count === 1 ? one : many}`;

const isLogin = (login: string | null, other: string | null) =>
  login !== null &&
  other !== null &&
  login.toLowerCase() === other.toLowerCase();

/** GitHub calls a deleted account ghost. */
export const personName = (login: string | null, viewer: string | null) =>
  isLogin(login, viewer) ? "You" : (login ?? "ghost");

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

const mergedEvent = ({ timeline }: PullRequest) =>
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

export const checkStates = {
  failed: { group: "Failing", result: "Failed" },
  running: { group: "Running", result: "Running" },
  passed: { group: "Passed", result: "Passed" },
  skipped: { group: "Skipped", result: "Skipped" },
} as const;
type CheckState = keyof typeof checkStates;
/** The worst first. */
const severity = Object.keys(checkStates) as CheckState[];

export const checkGroups = (checks: readonly Check[]) =>
  severity.flatMap((state) => {
    const own = checks.filter((check) => check.state === state);
    return own.length > 0 ? [{ state, checks: own }] : [];
  });

const countsOf = (checks: readonly Check[]) => {
  const count = (state: CheckState) =>
    checks.filter((check) => check.state === state).length;
  const passed = count("passed");
  const failed = count("failed");
  const running = count("running");
  // Skipped checks neither pass nor fail, so they don't count.
  return { passed, failed, running, total: passed + failed + running };
};

/** The inspector's one phrase. */
export function checksSummary(checks: PullRequest["checks"]): {
  kind: CheckState | "none";
  label: string;
} {
  if (checks === null) return { kind: "none", label: "No access" };
  const { passed, failed, running, total } = countsOf(checks.items);
  if (failed > 0)
    return { kind: "failed", label: `${failed.toLocaleString()} failing` };
  const unseen = checks.total - checks.items.length;
  if (unseen > 0)
    return {
      kind: "none",
      label: `${passed.toLocaleString()} passed, ${unseen.toLocaleString()} not shown`,
    };
  if (total > 0)
    return {
      kind: running > 0 ? "running" : "passed",
      label: `${passed.toLocaleString()} of ${total.toLocaleString()} passed`,
    };
  return checks.items.length > 0
    ? { kind: "skipped", label: "All skipped" }
    : { kind: "none", label: "None" };
}

/** "2 failing, 1 running, 11 passed". */
export const checksLine = (checks: readonly Check[]) =>
  checkGroups(checks)
    .map(
      ({ state, checks: own }) =>
        `${own.length.toLocaleString()} ${checkStates[state].group.toLowerCase()}`,
    )
    .join(", ");

/** When the first check began. */
export const checksStarted = (checks: readonly Check[]) =>
  checks
    .flatMap(({ startedAt }) => startedAt ?? [])
    .sort((left, right) => Date.parse(left) - Date.parse(right))[0] ?? null;

/** "48s", "6m 02s", "1h 04m". Null when GitHub gave no times that make sense. */
export function checkDuration(
  { startedAt, completedAt, state }: Check,
  now: number,
): string | null {
  if (startedAt === null || (completedAt === null && state !== "running"))
    return null;
  const end = completedAt === null ? now : seconds(completedAt);
  const took = Math.round(end - seconds(startedAt));
  if (took < 0) return null;
  const padded = (value: number) => String(value).padStart(2, "0");
  if (took < 60) return `${took}s`;
  const minutes = Math.floor(took / 60);
  if (minutes < 60) return `${minutes}m ${padded(took % 60)}s`;
  return `${Math.floor(minutes / 60)}h ${padded(minutes % 60)}m`;
}

/** A check's page, when it is one that may open. */
export const checkUrl = ({ url }: Check) =>
  url !== null && /^https:\/\//i.test(url) ? url : null;

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

type MergeKind =
  | "merged"
  | "closed"
  | "draft"
  | "conflicts"
  | "changesRequested"
  | "reviewRequired"
  | "requiredFailing"
  | "behind"
  | "blocked"
  | "failing"
  | "running"
  | "ready"
  | "unknown";
export type MergeBox = {
  kind: MergeKind;
  title: string;
  text: string;
  /** Whether someone has to act on GitHub before it can merge. */
  act: boolean;
};

/**
 * Whether it can merge and what stands in the way. The first that applies
 * wins, and it claims only what GitHub reports: L1 Git sees no branch rules.
 */
export function mergeBox(
  pull: PullRequest,
  viewer: string | null,
  ago: (at: string) => string,
): MergeBox {
  const { state, base, mergeable, mergeState } = pull;
  const checks = pull.checks?.items ?? [];
  const whole = pull.checks !== null && checks.length >= pull.checks.total;
  const { passed, failed, running, total } = countsOf(checks);
  const people = (wanted: ReviewState) =>
    reviewers(pull, viewer)
      .filter(({ state }) => state === wanted)
      .map(({ name }) =>
        name === "You" || name === "A team" ? name.toLowerCase() : name,
      );
  const required = (wanted: CheckState) =>
    checks.filter((check) => check.required && check.state === wanted);
  const blocked = mergeState === "blocked";
  const open =
    mergeable === "mergeable" &&
    (mergeState === "clean" ||
      mergeState === "unstable" ||
      mergeState === "hasHooks");
  const unsaid = "GitHub hasn't said yet whether this can merge.";
  // A login keeps its own letters, at the start of a sentence too.
  const sentence = (text: string) =>
    /^(?:a team|you|approved|all|the)\b/.test(text)
      ? text.charAt(0).toUpperCase() + text.slice(1)
      : text;

  if (state.kind === "merged") {
    const merged = mergedEvent(pull);
    return {
      kind: "merged",
      title: `Merged into ${base}`,
      text: merged?.oid
        ? `Merged as ${shortOid(merged.oid)} ${ago(state.at)}.`
        : `Merged ${ago(state.at)}.`,
      act: false,
    };
  }
  if (state.kind === "closed")
    return {
      kind: "closed",
      title: "Closed",
      text: `Closed without merging ${ago(state.at)}.`,
      act: false,
    };
  if (state.draft)
    return {
      kind: "draft",
      title: "Draft",
      text: "Code owners aren't asked to review yet. It can't merge while it's a draft.",
      act: true,
    };
  if (mergeable === "conflicting" || mergeState === "dirty")
    return {
      kind: "conflicts",
      title: `Conflicts with ${base}`,
      text: "The conflicts have to be resolved before this can merge.",
      act: true,
    };
  const refusing = people("changesRequested");
  if (refusing.length > 0)
    return {
      kind: "changesRequested",
      title: "Changes requested",
      text: sentence(
        `${named(refusing)} asked for changes${blocked ? ", and GitHub is blocking the merge" : ""}.`,
      ),
      act: true,
    };
  const requiredFailed = required("failed");
  const requiredRunning = required("running");
  const asked = people("requested");
  const approved = people("approved");
  // A failing or running required check explains the block by itself.
  if (
    blocked &&
    requiredFailed.length === 0 &&
    requiredRunning.length === 0 &&
    asked.length > 0
  )
    return {
      kind: "reviewRequired",
      title: "Review required",
      text: `GitHub is blocking the merge. Waiting for ${named(asked)} to review.`,
      act: true,
    };
  if (requiredFailed.length > 0)
    return {
      kind: "requiredFailing",
      title: `${counted(requiredFailed.length, "required check is", "required checks are")} failing`,
      text: `${named(requiredFailed.map(({ name }) => name))} must pass before this can merge.`,
      act: true,
    };
  if (mergeState === "behind")
    return {
      kind: "behind",
      title: `Behind ${base}`,
      text: `${base} only accepts branches that are up to date with it.`,
      act: true,
    };
  if (blocked && requiredRunning.length === 0)
    return {
      kind: "blocked",
      title: "Merging is blocked",
      text:
        approved.length === 0
          ? "GitHub is blocking the merge, and nobody has approved this yet."
          : "GitHub is blocking the merge and doesn't tell L1 Git which rule asks for more.",
      act: true,
    };
  const waits = (otherwise: string) => {
    if (requiredRunning.length > 0)
      return `Merging waits for ${counted(requiredRunning.length, "required check")}.`;
    return open ? otherwise : unsaid;
  };
  if (failed > 0)
    return {
      kind: "failing",
      title: `${counted(failed, "check is", "checks are")} failing`,
      text: waits(
        whole
          ? `None of them is required on ${base}, so this can still merge.`
          : "This can still merge.",
      ),
      act: false,
    };
  if (running > 0)
    return {
      kind: "running",
      title: whole
        ? `${(total - running).toLocaleString()} of ${counted(total, "check")} done`
        : `${counted(running, "check is", "checks are")} running`,
      text: waits(
        whole
          ? "None of the others is required, so this can merge now."
          : "This can merge now.",
      ),
      act: false,
    };
  if (open && mergeState === "unstable" && !whole)
    return {
      kind: "unknown",
      title: "A check hasn't passed",
      text: "It isn't required, so this can still merge. L1 Git can't see which one it is.",
      act: false,
    };
  if (open) {
    const all =
      whole && total > 0 && passed === total
        ? total === 1
          ? "the only check passed"
          : `all ${total.toLocaleString()} checks passed`
        : null;
    const by = approved.length > 0 ? `approved by ${named(approved)}` : null;
    return {
      kind: "ready",
      title: "Ready to merge",
      text: sentence(
        `${by && all ? `${by}, and ${all}` : (by ?? all ?? "GitHub finds nothing that stops it")}.`,
      ),
      act: false,
    };
  }
  return {
    kind: "unknown",
    title: "Can't tell yet",
    text: unsaid,
    act: false,
  };
}
