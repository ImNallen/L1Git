import { firstOf } from "./changeStops";

/** A change of one of several files, or with no change the beginning of a file that is not read. */
export type FileStep = { file: number; change: number | null };

/** How many changes to stop at in a file. Null when it is not read, and undefined when there is no such file. */
type CountOf = (file: number) => number | null | undefined;

function beyond(countOf: CountOf, from: number, by: 1 | -1): FileStep | null {
  for (let file = from + by; ; file += by) {
    const count = countOf(file);
    if (count === undefined) return null;
    if (count === null) return { file, change: null };
    if (count > 0) return { file, change: by === 1 ? 0 : count - 1 };
  }
}

/**
 * The step after a change, or before it. `change` can be -1, before all in the
 * file, and as many as it has, after them.
 */
export function stepFrom(
  countOf: CountOf,
  { file, change }: { file: number; change: number },
  by: 1 | -1,
): FileStep | null {
  const count = countOf(file);
  if (count === null) return { file, change: null };
  const next = change + by;
  return count !== undefined && next >= 0 && next < count
    ? { file, change: next }
    : beyond(countOf, file, by);
}

/**
 * The step after where the view begins, or before it. The view begins in
 * `file`, and the files from `first` to `last` are drawn. `topOf` says where
 * it would begin for a step to one of them, which takes time to say.
 */
export function stepInView(
  countOf: CountOf,
  view: { first: number; last: number; file: number; at: number },
  topOf: (step: FileStep) => number,
  by: 1 | -1,
): FileStep | null {
  const { first, last, at } = view;
  for (
    let file = by === 1 ? first : last;
    file >= first && file <= last;
    file += by
  ) {
    const count = countOf(file);
    if (count === null) {
      const top = topOf({ file, change: null });
      // What is not read of the file that the view begins in is yet to come.
      const isNext =
        by === 1 ? top > at + 1 || file === view.file : top < at - 1;
      if (isNext) return { file, change: null };
    } else if (count) {
      const found =
        by === 1
          ? firstOf(count, (change) => topOf({ file, change }) > at + 1)
          : firstOf(count, (change) => topOf({ file, change }) >= at - 1) - 1;
      if (found >= 0 && found < count) return { file, change: found };
    }
  }
  return beyond(countOf, by === 1 ? last : first, by);
}

/** The one that is more of a step. */
export function furtherStep(
  one: FileStep | null,
  other: FileStep | null,
  by: 1 | -1,
): FileStep | null {
  if (!one || !other) return one ?? other;
  const ahead =
    one.file - other.file || (one.change ?? -1) - (other.change ?? -1);
  return ahead * by >= 0 ? one : other;
}
