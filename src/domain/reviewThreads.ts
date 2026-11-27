import type { DiffLineAnnotation, FileDiffMetadata } from "@pierre/diffs";
import { draftKey } from "./drafts";
import type { DraftKey } from "./drafts";
import type { LineAnchor, Lines } from "./lineComments";
import type { ReviewThread } from "./pullRequest";
import type { Oid } from "./repository";
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

/**
 * What a line of a review diff carries. Ids only, never typed words: Pierre
 * draws every line again for a changed list, and drops the selection.
 */
export type LineNote = {
  readonly threads: readonly string[];
  /** Pending comments, written against the head shown. */
  readonly drafts: readonly DraftKey[];
  /** Single comments sent from here, by attempt, until a read shows them. */
  readonly sent: readonly string[];
  /** Whether the open comment box belongs on this line. */
  readonly box: boolean;
};
export type NotesOnLine = DiffLineAnnotation<LineNote>;

/** What there is to show on a file's lines, at any head. */
export type Notes = {
  threads: readonly ReviewThread[];
  drafts: readonly { key: DraftKey; anchor: LineAnchor; head: Oid }[];
  sent: readonly { id: string; lines: Lines; commit: Oid }[];
  /** The open comment box, at the head shown, with the attempt it sent. */
  box: { anchor: LineAnchor; attempt: string | null } | null;
};

/** What has no line in what is shown of a file. */
export type Elsewhere = {
  threads: readonly ReviewThread[];
  drafts: readonly DraftKey[];
  sent: readonly string[];
};

const sides = { left: "deletions", right: "additions" } as const;

function shows(
  { hunks }: FileDiffMetadata,
  side: NotesOnLine["side"],
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

const empty: LineNote = { threads: [], drafts: [], sent: [], box: false };

/**
 * Where a file's notes show in its patch at `head`, which for a changed type
 * is two parts. A pending comment or a sent one of another head, like an
 * outdated thread, is elsewhere: a line number means something at one commit
 * only. The box shows its own draft and its own attempt. Without `left`, the
 * old side is a commit GitHub has never seen, and what is on it is elsewhere.
 */
export function placeNotes(
  { threads, drafts, sent, box }: Notes,
  head: Oid,
  patch: readonly FileDiffMetadata[],
  { left }: { left: boolean } = { left: true },
): { onLines: NotesOnLine[][]; elsewhere: Elsewhere } {
  const onLines = patch.map(() => new Map<string, NotesOnLine>());
  const elsewhere = {
    threads: [] as ReviewThread[],
    drafts: [] as DraftKey[],
    sent: [] as string[],
  };
  const put = (
    at: {
      side: "left" | "right";
      line: number | null;
      start?: { side: "left" | "right" } | null;
    } | null,
    add: (note: LineNote) => LineNote,
  ): boolean => {
    if (at === null || at.line === null) return false;
    if (!left && (at.side === "left" || at.start?.side === "left"))
      return false;
    const side = sides[at.side];
    const { line } = at;
    const places = onLines[patch.findIndex((each) => shows(each, side, line))];
    if (!places) return false;
    const key = `${side} ${line}`;
    const note = places.get(key)?.metadata ?? empty;
    places.set(key, { side, lineNumber: line, metadata: add(note) });
    return true;
  };
  for (const thread of threads)
    if (
      !put(thread.outdated ? null : thread, (note) => ({
        ...note,
        threads: [...note.threads, thread.id],
      }))
    )
      elsewhere.threads.push(thread);
  const own = box && draftKey(box.anchor, head);
  for (const draft of drafts) {
    if (draft.key === own) continue;
    const at = draft.head === head ? draft.anchor : null;
    if (!put(at, (note) => ({ ...note, drafts: [...note.drafts, draft.key] })))
      elsewhere.drafts.push(draft.key);
  }
  for (const { id, lines, commit } of sent) {
    if (id === box?.attempt) continue;
    const at = commit === head ? lines : null;
    if (!put(at, (note) => ({ ...note, sent: [...note.sent, id] })))
      elsewhere.sent.push(id);
  }
  if (box) put(box.anchor, (note) => ({ ...note, box: true }));
  return { onLines: onLines.map((each) => [...each.values()]), elsewhere };
}

export function elsewhereLabel({ threads, drafts, sent }: Elsewhere): string {
  const count = commentsIn(threads) + drafts.length + sent.length;
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
