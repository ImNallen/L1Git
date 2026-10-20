import type { GraphRow } from "./graph";
import type { Commit, Oid } from "./repository";

export type Move = "up" | "down" | "first" | "last" | "child" | "parent";
export type HistoryAction = Move | "open" | "cancel" | "columns";

export type HistoryKey = Pick<
  KeyboardEvent,
  "key" | "shiftKey" | "metaKey" | "ctrlKey" | "altKey"
>;

export type HistoryBinding = {
  key: string;
  shift: boolean;
  cmdOrCtrl: boolean;
  action: HistoryAction;
};

const binding = (
  key: string,
  action: HistoryAction,
  modifiers: { shift?: true; cmdOrCtrl?: true } = {},
): HistoryBinding => ({
  key,
  shift: modifiers.shift ?? false,
  cmdOrCtrl: modifiers.cmdOrCtrl ?? false,
  action,
});

export const historyBindings: readonly HistoryBinding[] = [
  binding("ArrowDown", "down"),
  binding("j", "down"),
  binding("ArrowUp", "up"),
  binding("k", "up"),
  binding("Home", "first"),
  binding("Home", "first", { cmdOrCtrl: true }),
  binding("ArrowUp", "first", { cmdOrCtrl: true }),
  binding("End", "last"),
  binding("End", "last", { cmdOrCtrl: true }),
  binding("ArrowDown", "last", { cmdOrCtrl: true }),
  binding("ArrowDown", "parent", { shift: true }),
  binding("j", "parent", { shift: true }),
  binding("ArrowUp", "child", { shift: true }),
  binding("k", "child", { shift: true }),
  binding("Enter", "open"),
  binding("Escape", "cancel"),
  binding("ContextMenu", "columns"),
  binding("F10", "columns", { shift: true }),
];

export function historyAction(event: HistoryKey): HistoryAction | null {
  if (event.altKey) return null;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  const cmdOrCtrl = event.metaKey || event.ctrlKey;
  return (
    historyBindings.find(
      (binding) =>
        binding.key === key &&
        binding.shift === event.shiftKey &&
        binding.cmdOrCtrl === cmdOrCtrl,
    )?.action ?? null
  );
}

export type Trail = { end: Oid; passed: readonly Oid[] };

export function navigate(
  commits: readonly Pick<Commit, "oid" | "parents">[],
  graph: ReadonlyMap<Oid, GraphRow>,
  selected: Oid | null,
  move: Move,
  trail: Trail | null,
): { oid: Oid | null; trail: Trail | null } {
  const kept = trail?.end === selected ? trail.passed : [];
  const step = kept.at(-1);
  const passed =
    step !== undefined && graph.get(step)?.parents.at(0)?.oid === selected
      ? kept
      : [];
  const previous = passed.at(-1);
  if (move === "child" && previous !== undefined) {
    const rest = passed.slice(0, -1);
    return {
      oid: previous,
      trail: rest.length > 0 ? { end: previous, passed: rest } : null,
    };
  }
  const oid = nextRow(commits, graph, selected, move);
  if (move === "parent" && selected !== null && oid !== null)
    return oid === selected
      ? { oid, trail }
      : { oid, trail: { end: oid, passed: [...passed, selected] } };
  return { oid, trail: null };
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
    const firstParent = commit.parents.at(0) === target;
    if (straight && firstParent) return commit;
    if (row.continuations.some((lane) => lane.oid === target)) continue;
    return edge && firstParent ? commit : undefined;
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
