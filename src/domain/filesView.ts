/** A file's beginning or one of its lines, and how far below the top of the view it is. */
export type FilesPlace = {
  id: string;
  line: { side: "deletions" | "additions"; number: number } | null;
  below: number;
};

/** Where the view of all files is, and who has it there. */
export type FilesView =
  /** The reader scrolled there. */
  | { kind: "free" }
  /** The app put it there, and puts it there again when the layout changes. */
  | {
      kind: "put";
      place: FilesPlace;
      /** The file that is current there, or null for the one at the top. */
      file: number | null;
    }
  /** Marking the file `of` put it there, and unmarking puts it back. */
  | {
      kind: "marked";
      place: FilesPlace;
      file: number | null;
      of: number;
      back: FilesPlace;
    };

/** The current file, when `atTop` is the one at the top of the view. */
export const currentFile = (
  view: FilesView,
  atTop: number | null,
): number | null => (view.kind === "free" ? atTop : (view.file ?? atTop));

/** The same view, with another place in it. */
export const viewAt = (
  view: FilesView,
  place: FilesPlace | null,
): FilesView => {
  if (!place) return view;
  return view.kind === "free"
    ? { kind: "put", place, file: null }
    : { ...view, place };
};

/** Pierre keeps whole pixels. */
const SAME = 1;

/**
 * What to do with a view that is to begin at `wanted`, as it was to at `last`.
 * Nothing but the reader moves it while the layout stays as it is.
 */
export function afterMove(
  scrollTop: number,
  wanted: number,
  last: number | null,
): "stay" | "put" | "free" {
  if (Math.abs(scrollTop - wanted) <= SAME) return "stay";
  const isSame = last !== null && Math.abs(wanted - last) <= SAME;
  return isSame ? "free" : "put";
}

/**
 * The view that marking a file leaves, or null for the same. `here` is the top
 * of the view, `below` how far below it the file begins, and `next` where the
 * next file does.
 */
export function viewToMark(
  view: FilesView,
  mark: {
    at: number;
    isViewed: boolean;
    isFolded: boolean;
    here: FilesPlace;
    own: FilesPlace;
    below: number;
    /** Null when the header is to stay in the view. */
    next: FilesPlace | null;
  },
): FilesView | null {
  const { at, isViewed, isFolded, here, own, below, next } = mark;
  // Marking folds it, and unmarking unfolds it.
  if (isViewed === isFolded) return null;
  if (isViewed) {
    const isPinned = below < 0;
    const file = view.kind === "free" ? null : view.file;
    return {
      kind: "marked",
      place: isPinned ? (next ?? own) : here,
      // It stays current, also when the next one comes to the top.
      file: file ?? (isPinned ? at : null),
      of: at,
      back: here,
    };
  }
  if (view.kind === "marked" && view.of === at)
    return { kind: "put", place: view.back, file: view.file };
  return below < 0 ? { kind: "put", place: own, file: at } : null;
}
