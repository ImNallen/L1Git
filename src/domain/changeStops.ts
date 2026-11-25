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

/**
 * Where to scroll for the next change or the one before, or null when that
 * would move nothing. `tops` are where the changes are, `at` is where the view
 * begins, and `most` how far it scrolls. `above` is what to leave over a change.
 */
export function scrollToChange(
  tops: readonly number[],
  { at, most, above }: { at: number; most: number; above: number },
  by: 1 | -1,
): number | null {
  const wanted = tops.map((top) => Math.min(Math.max(top - above, 0), most));
  const found =
    by === 1
      ? wanted.find((each) => each > at + 1)
      : wanted.findLast((each) => each < at - 1);
  return found ?? null;
}
