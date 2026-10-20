import type { GraphRow } from "./graph";
import type { Commit, Oid } from "./repository";

/** `branch-up` and `branch-down` follow the selected commit's first-parent line. */
export type Move =
  | "up"
  | "down"
  | "first"
  | "last"
  | "branch-up"
  | "branch-down";

export type HistoryKey = Pick<
  KeyboardEvent,
  "key" | "shiftKey" | "metaKey" | "ctrlKey" | "altKey"
>;

/** What a key pressed in the history does, or `null` when the history ignores it. */
export function historyAction(key: HistoryKey): Move | "open" | null {
  if (key.altKey) return null;
  const command = key.metaKey || key.ctrlKey;
  if (command && !key.shiftKey) {
    if (key.key === "ArrowUp") return "first";
    if (key.key === "ArrowDown") return "last";
    return null;
  }
  if (command) return null;
  if (key.shiftKey) {
    if (key.key === "ArrowUp") return "branch-up";
    if (key.key === "ArrowDown") return "branch-down";
    return null;
  }
  switch (key.key) {
    case "ArrowUp":
    case "k":
      return "up";
    case "ArrowDown":
    case "j":
      return "down";
    case "Home":
      return "first";
    case "End":
      return "last";
    case "Enter":
      return "open";
    default:
      return null;
  }
}

/**
 * The commit a move selects among the loaded `commits`, newest first. Without
 * a loaded selection, `last` selects the oldest commit and every other move the
 * newest. A move past either end, or off the loaded branch, keeps `selected`.
 */
export function nextRow(
  commits: readonly Pick<Commit, "oid" | "parents">[],
  graph: ReadonlyMap<Oid, GraphRow>,
  selected: Oid | null,
  move: Move,
): Oid | null {
  const index = commits.findIndex((commit) => commit.oid === selected);
  const current = commits[index];
  if (current === undefined || move === "first" || move === "last")
    return (move === "last" ? commits.at(-1) : commits.at(0))?.oid ?? null;
  switch (move) {
    case "up":
      return (commits[index - 1] ?? current).oid;
    case "down":
      return (commits[index + 1] ?? current).oid;
    case "branch-down": {
      const parent = current.parents.at(0);
      return parent !== undefined && graph.has(parent) ? parent : current.oid;
    }
    case "branch-up": {
      const children = commits
        .slice(0, index)
        .filter((commit) => commit.parents.at(0) === current.oid);
      // A fork point has several first-parent children. The nearest one drawn
      // in the same lane continues the line the eye follows.
      const lane = graph.get(current.oid)?.lane;
      const child =
        children.findLast((commit) => graph.get(commit.oid)?.lane === lane) ??
        children.at(-1);
      return child?.oid ?? current.oid;
    }
  }
}

/**
 * The scroll offset that brings row `index` fully into a viewport of `height`
 * pixels below a sticky header, moving as little as possible.
 */
export function revealRow(
  index: number,
  rowHeight: number,
  scrollTop: number,
  height: number,
): number {
  const top = index * rowHeight;
  if (top < scrollTop) return top;
  if (top + rowHeight > scrollTop + height) return top + rowHeight - height;
  return scrollTop;
}
