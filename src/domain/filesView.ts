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
