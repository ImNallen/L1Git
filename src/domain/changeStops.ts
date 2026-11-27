import type { FileDiffMetadata } from "@pierre/diffs";

export type ChangeStop = {
  /** Which part of the patch. */
  part: number;
  side: "deletions" | "additions";
  line: number;
};

/** Where each run of changed lines begins. */
export function changeStops(patch: readonly FileDiffMetadata[]): ChangeStop[] {
  return patch.flatMap(({ hunks }, part) =>
    hunks.flatMap(({ deletionStart, additionStart, hunkContent }) => {
      let deletion = deletionStart;
      let addition = additionStart;
      return hunkContent.flatMap((block, at): ChangeStop[] => {
        if (block.type === "context") {
          deletion += block.lines;
          addition += block.lines;
          return [];
        }
        const stop: ChangeStop =
          block.deletions > 0
            ? { part, side: "deletions", line: deletion }
            : { part, side: "additions", line: addition };
        deletion += block.deletions;
        addition += block.additions;
        // Pierre draws some of one run's added lines before its deleted ones.
        return hunkContent[at - 1]?.type === "change" ? [] : [stop];
      });
    }),
  );
}

/**
 * The part of a file's patch whose hunks hold a line. A place named before
 * the patch was read, such as a thread's line, says part 0, and a file whose
 * type changed has two parts. Where no hunk holds the line, the part named.
 */
export function partOf(
  patch: readonly (FileDiffMetadata | null | undefined)[],
  {
    part,
    side,
    number,
  }: { part: number; side: ChangeStop["side"]; number: number },
): number {
  const holds = (diff: FileDiffMetadata | null | undefined) =>
    diff?.hunks.some((hunk) =>
      side === "additions"
        ? number >= hunk.additionStart &&
          number < hunk.additionStart + hunk.additionCount
        : number >= hunk.deletionStart &&
          number < hunk.deletionStart + hunk.deletionCount,
    ) ?? false;
  if (holds(patch[part])) return part;
  const found = patch.findIndex(holds);
  return found < 0 ? part : found;
}

/** The first of `count` for which `is` is true, when it is for each one after. */
export function firstOf(count: number, is: (index: number) => boolean): number {
  let from = 0;
  let to = count;
  while (from < to) {
    const middle = (from + to) >> 1;
    if (is(middle)) to = middle;
    else from = middle + 1;
  }
  return from;
}

/**
 * The next change or the one before, and where to scroll for it, or null when
 * that would move nothing. `topOf` is where one of the `count` changes is,
 * which takes time to say, `at` is where the view begins, and `most` how far
 * it scrolls. `above` is what to leave over a change.
 */
type View = { at: number; most: number; above: number };

const scrollFor =
  (topOf: (change: number) => number, { most, above }: View) =>
  (change: number) =>
    Math.min(Math.max(topOf(change) - above, 0), most);

export function nextChange(
  count: number,
  topOf: (change: number) => number,
  view: View,
  by: 1 | -1,
): { change: number; scrollTop: number } | null {
  const { at } = view;
  const wanted = scrollFor(topOf, view);
  const found =
    by === 1
      ? firstOf(count, (change) => wanted(change) > at + 1)
      : firstOf(count, (change) => wanted(change) >= at - 1) - 1;
  return found < 0 || found >= count
    ? null
    : { change: found, scrollTop: wanted(found) };
}

/** The change the view is at: the one a step went to, or else the first
 * below where the view begins. Null when every change is above it. */
export function changeAt(
  count: number,
  topOf: (change: number) => number,
  view: View,
): number | null {
  const wanted = scrollFor(topOf, view);
  const found = firstOf(count, (change) => wanted(change) >= view.at - 1);
  return found < count ? found : null;
}
