import type { DiffLineAnnotation, FileDiffMetadata } from "@pierre/diffs";
import type { ReviewThread } from "./pullRequest";
import { counted, personName } from "./pullRequestDetail";
import type { RangeFile } from "./range";

/**
 * A thread on an outdated line keeps the path that the file had. One on a file
 * that the range leaves alone is on none.
 */
export function threadsByFile(
  files: readonly RangeFile[],
  threads: readonly ReviewThread[],
): Map<RangeFile, ReviewThread[]> {
  const moved = files.flatMap((file) =>
    file.from === null ? [] : [[file.from, file] as const],
  );
  const fileAt = new Map([
    ...moved,
    ...files.map((file) => [file.path, file] as const),
  ]);
  const found = new Map<RangeFile, ReviewThread[]>();
  for (const thread of threads) {
    const file = fileAt.get(thread.path);
    if (file) found.set(file, [...(found.get(file) ?? []), thread]);
  }
  return found;
}

export const commentsIn = (threads: readonly ReviewThread[]) =>
  threads.reduce((sum, { comments }) => sum + comments.total, 0);

/** The ids of the threads on a line. */
export type ThreadsOnLine = DiffLineAnnotation<readonly string[]>;

const sides = { left: "deletions", right: "additions" } as const;

function shows(
  { hunks }: FileDiffMetadata,
  side: ThreadsOnLine["side"],
  line: number,
): boolean {
  return hunks.some((hunk) => {
    const [start, count] =
      side === "deletions"
        ? [hunk.deletionStart, hunk.deletionCount]
        : [hunk.additionStart, hunk.additionCount];
    return line >= start && line < start + count;
  });
}

/** Where a file's threads show in its patch, which for a changed type is two. */
export function placeThreads(
  threads: readonly ReviewThread[],
  patch: readonly FileDiffMetadata[],
): {
  /** For each part of the patch. */
  onLines: ThreadsOnLine[][];
  elsewhere: ReviewThread[];
} {
  const onLines = patch.map(() => new Map<string, ThreadsOnLine>());
  const elsewhere: ReviewThread[] = [];
  for (const thread of threads) {
    const { line, outdated } = thread;
    const side = sides[thread.side];
    const part =
      line === null || outdated
        ? -1
        : patch.findIndex((each) => shows(each, side, line));
    const places = onLines[part];
    if (line === null || places === undefined) {
      elsewhere.push(thread);
      continue;
    }
    const key = `${side} ${line}`;
    places.set(key, {
      side,
      lineNumber: line,
      metadata: [...(places.get(key)?.metadata ?? []), thread.id],
    });
  }
  return { onLines: onLines.map((each) => [...each.values()]), elsewhere };
}

export function elsewhereLabel(threads: readonly ReviewThread[]): string {
  const count = commentsIn(threads);
  return `${counted(count, "comment")} that ${count === 1 ? "isn't" : "aren't"} on a line here`;
}

const MOST_READ = 2_000;
const MOST_SHOWN = 140;

/** The beginning of a text, in one line and without most of its marks. */
export function firstWords(body: string): string {
  const words = body
    .slice(0, MOST_READ)
    .replace(/<!--[^]*?(?:-->|$)/g, " ")
    .replace(/^[ \t]*(?:```|~~~).*$/gm, " ")
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, "$1")
    .replace(/^[ \t>]*(?:#{1,6} |[-*+] )?/gm, "")
    .replace(/[*`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const letters = [...words];
  return letters.length > MOST_SHOWN
    ? `${letters.slice(0, MOST_SHOWN).join("").trimEnd()}…`
    : words;
}

const MOST_PEOPLE = 3;

export function chipOf({ comments }: ReviewThread, viewer: string) {
  const first = comments.items[0];
  const words = first ? firstWords(first.body) : "";
  return {
    people: [...new Set(comments.items.map(({ by }) => by))].slice(
      0,
      MOST_PEOPLE,
    ),
    count: counted(comments.total, "comment"),
    by: first ? personName(first.by, viewer) : null,
    words,
  };
}
