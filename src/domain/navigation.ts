import type { GraphRow } from "./graph";
import type { Commit, Oid } from "./repository";

export type Move = "up" | "down" | "first" | "last" | "child" | "parent";

export type HistoryKey = Pick<
  KeyboardEvent,
  "key" | "shiftKey" | "metaKey" | "ctrlKey" | "altKey"
>;

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
    if (key.key === "ArrowUp") return "child";
    if (key.key === "ArrowDown") return "parent";
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
    case "parent": {
      const parent = current.parents.at(0);
      return parent !== undefined && graph.has(parent) ? parent : current.oid;
    }
    case "child": {
      const child =
        lineChild(commits, graph, index) ??
        commits
          .slice(0, index)
          .findLast((commit) => commit.parents.at(0) === current.oid);
      return child?.oid ?? current.oid;
    }
  }
}

function lineChild(
  commits: readonly Pick<Commit, "oid" | "parents">[],
  graph: ReadonlyMap<Oid, GraphRow>,
  index: number,
): Pick<Commit, "oid" | "parents"> | undefined {
  const target = commits[index]?.oid;
  for (let above = index - 1; above >= 0; above--) {
    const commit = commits[above];
    const row = commit && graph.get(commit.oid);
    if (!row) return undefined;
    const edge = row.parents.find((parent) => parent.oid === target);
    const straight = edge !== undefined && edge.from === edge.to;
    if (!straight && row.continuations.some((lane) => lane.oid === target))
      continue;
    return edge && commit.parents.at(0) === target ? commit : undefined;
  }
  return undefined;
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
