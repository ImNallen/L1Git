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
      return hunkContent.flatMap((block): ChangeStop[] => {
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
        return [stop];
      });
    }),
  );
}

/** The first of `count` for which `is` is true, when it is for each one after. */
function firstOf(count: number, is: (index: number) => boolean): number {
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
export function nextChange(
  count: number,
  topOf: (change: number) => number,
  { at, most, above }: { at: number; most: number; above: number },
  by: 1 | -1,
): { change: number; scrollTop: number } | null {
  const wanted = (change: number) =>
    Math.min(Math.max(topOf(change) - above, 0), most);
  const found =
    by === 1
      ? firstOf(count, (change) => wanted(change) > at + 1)
      : firstOf(count, (change) => wanted(change) >= at - 1) - 1;
  return found < 0 || found >= count
    ? null
    : { change: found, scrollTop: wanted(found) };
}
