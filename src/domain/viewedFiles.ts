import { z } from "zod";
import type { RangeFile } from "./range";
import type { ListedRepository } from "./pullRequestList";
import type { Oid } from "./repository";

const MOST_PULLS = 200;
const MOST_MARKS = 5_000;
/** Of all marks together, which leaves room for what else is stored. */
const MOST_CHARACTERS = 1_500_000;

/** The pull request that was marked last is last, and so is its newest mark. */
export const viewedRecordSchema = z.object({
  version: z.literal(1),
  pulls: z.array(z.object({ pull: z.string(), marks: z.array(z.string()) })),
});
export type ViewedRecord = z.infer<typeof viewedRecordSchema>;
export const emptyRecord: ViewedRecord = { version: 1, pulls: [] };
export type MarkChange = { pull: string; mark: string; isViewed: boolean };

export const pullName = (
  { key }: Pick<ListedRepository, "key">,
  number: number,
) => `${key}#${number}`;

/** Too long to find another file's that begins the same. */
const start = (oid: Oid | null) => oid?.slice(0, 16) ?? "-";

/** Another one for each change to the file. Nothing in it but paths can hold a space, and no path holds a zero byte. */
export const markOf = ({
  path,
  from,
  oldBlob,
  newBlob,
  oldMode,
  newMode,
}: RangeFile) =>
  [
    start(oldBlob),
    start(newBlob),
    oldMode ?? "-",
    newMode ?? "-",
    from === null ? path : `${from}\0${path}`,
  ].join(" ");

/** The newest there is room for. */
function capped(pulls: ViewedRecord["pulls"]): ViewedRecord["pulls"] {
  let room = MOST_CHARACTERS;
  const kept: ViewedRecord["pulls"] = [];
  for (const { pull, marks } of pulls.slice(-MOST_PULLS).reverse()) {
    const least = Math.max(0, marks.length - MOST_MARKS);
    let first = marks.length;
    while (first > least && (marks[first - 1]?.length ?? 0) <= room) {
      first -= 1;
      room -= marks[first]?.length ?? 0;
    }
    if (first < marks.length) kept.push({ pull, marks: marks.slice(first) });
  }
  return kept.reverse();
}

export function withChanges(
  record: ViewedRecord,
  changes: readonly MarkChange[],
): ViewedRecord {
  const pulls = new Map(
    record.pulls.map(({ pull, marks }) => [pull, new Set(marks)]),
  );
  for (const { pull, mark, isViewed } of changes) {
    const marks = pulls.get(pull) ?? new Set();
    marks.delete(mark);
    if (isViewed) marks.add(mark);
    pulls.delete(pull);
    pulls.set(pull, marks);
  }
  return {
    version: 1,
    pulls: capped(
      [...pulls].map(([pull, marks]) => ({ pull, marks: [...marks] })),
    ),
  };
}

export function viewedAmong(
  files: readonly RangeFile[],
  record: ViewedRecord,
  name: string,
): ReadonlySet<RangeFile> {
  const own = record.pulls.find(({ pull }) => pull === name);
  const marks = new Set(own?.marks);
  return new Set(
    marks.size === 0 ? [] : files.filter((file) => marks.has(markOf(file))),
  );
}

/** The first after `at` that is not viewed, or else from the top, and null when there is none but the one at `at`. */
export function nextUnviewed(
  files: readonly RangeFile[],
  viewed: ReadonlySet<RangeFile>,
  at: number,
): number | null {
  const isNext = (file: RangeFile, place: number) =>
    place !== at && !viewed.has(file);
  const after = files.findIndex(
    (file, place) => place > at && isNext(file, place),
  );
  const next = after === -1 ? files.findIndex(isNext) : after;
  return next === -1 ? null : next;
}

/** "Viewed 3 of 14". */
export const viewedCount = (viewed: number, of: number) =>
  `${viewed.toLocaleString()} of ${of.toLocaleString()}`;
