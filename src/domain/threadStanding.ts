import type { ReviewThread } from "./pullRequest";
import { firstWords } from "./reviewThreads";

/** Where a review thread stands for the viewer. Each thread has one, so the
 * counts add up: every thread that isn't resolved is open, and some open ones
 * wait on you or are outdated. */
export type Standing = "waitingOnYou" | "outdated" | "open" | "resolved";

export const threadFilters = [
  "open",
  "waitingOnYou",
  "outdated",
  "resolved",
] as const;
export type ThreadFilter = (typeof threadFilters)[number];

const isViewer = (login: string | null, viewer: string) =>
  login !== null && login.toLowerCase() === viewer.toLowerCase();

/** The last reply answers a comment the viewer wrote. Only a thread read
 * whole says who spoke last. */
function waitsOn(
  { comments: { items, total } }: Pick<ReviewThread, "comments">,
  viewer: string,
) {
  const last = items.at(-1);
  if (!last || items.length < total || isViewer(last.by, viewer)) return false;
  return items.slice(0, -1).some(({ by }) => isViewer(by, viewer));
}

export function standing(
  thread: Pick<ReviewThread, "resolved" | "outdated" | "comments">,
  viewer: string,
): Standing {
  if (thread.resolved) return "resolved";
  if (waitsOn(thread, viewer)) return "waitingOnYou";
  return thread.outdated ? "outdated" : "open";
}

const shows = (filter: ThreadFilter, of: Standing) =>
  filter === "open" ? of !== "resolved" : filter === of;

/** ":89", ":100–102", or "File" for a thread on the whole file. */
function placeOf({
  line,
  startLine,
  originalLine,
  originalStartLine,
}: ReviewThread): string {
  const [end, start] =
    line === null ? [originalLine, originalStartLine] : [line, startLine];
  if (end === null) return "File";
  return start === null || start === end ? `:${end}` : `:${start}–${end}`;
}

export type ThreadRow = {
  thread: ReviewThread;
  standing: Standing;
  place: string;
  /** The login of who began it. */
  by: string | null;
  words: string;
  replies: number;
  /** When its newest comment that was read was written. */
  at: string | null;
};

const lineOf = ({ line, originalLine }: ReviewThread) =>
  line ?? originalLine ?? 0;

/**
 * The threads one filter shows, by file and then by line. `kept` are the
 * ones acted on in this view, which stay where they were until the filter
 * changes, so a thread doesn't leave under the pointer.
 */
export function threadsView(
  threads: readonly ReviewThread[],
  viewer: string,
  filter: ThreadFilter,
  kept: ReadonlySet<string>,
) {
  const counts: Record<ThreadFilter, number> = {
    open: 0,
    waitingOnYou: 0,
    outdated: 0,
    resolved: 0,
  };
  const byPath = new Map<string, ThreadRow[]>();
  /** The resolved threads behind "Show them". */
  let hidden = 0;
  for (const thread of threads) {
    const of = standing(thread, viewer);
    for (const each of threadFilters) if (shows(each, of)) counts[each] += 1;
    if (!shows(filter, of) && !kept.has(thread.id)) {
      if (filter === "open") hidden += 1;
      continue;
    }
    const { items, total } = thread.comments;
    const first = items[0];
    byPath.set(thread.path, [
      ...(byPath.get(thread.path) ?? []),
      {
        thread,
        standing: of,
        place: placeOf(thread),
        by: first?.by ?? null,
        words: first ? firstWords(first.body) : "",
        replies: Math.max(0, total - 1),
        at: items.at(-1)?.at ?? null,
      },
    ]);
  }
  const groups = [...byPath]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([path, rows]) => ({
      path,
      rows: rows.sort(
        (left, right) => lineOf(left.thread) - lineOf(right.thread),
      ),
    }));
  return { counts, groups, hidden };
}
