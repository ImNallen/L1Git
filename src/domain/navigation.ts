import type { GraphNode, GraphRow, RowId } from "./graph";
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

export type Trail = { end: RowId; passed: readonly RowId[] };

export function navigate(
  rows: readonly GraphNode[],
  graph: ReadonlyMap<RowId, GraphRow>,
  selected: RowId | null,
  move: Move,
  trail: Trail | null,
): { id: RowId | null; trail: Trail | null } {
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
      id: previous,
      trail: rest.length > 0 ? { end: previous, passed: rest } : null,
    };
  }
  const id = nextRow(rows, graph, selected, move);
  if (move === "parent" && selected !== null && id !== null)
    return id === selected
      ? { id, trail }
      : { id, trail: { end: id, passed: [...passed, selected] } };
  return { id, trail: null };
}

export function landingFromHidden(
  all: readonly Pick<Commit, "oid">[],
  shown: ReadonlySet<Oid>,
  selected: Oid | null,
  move: Move,
): Oid | null {
  if (
    selected === null ||
    shown.has(selected) ||
    move === "first" ||
    move === "last"
  )
    return null;
  const index = all.findIndex((commit) => commit.oid === selected);
  if (index < 0) return null;
  const older = all.slice(index + 1).find((commit) => shown.has(commit.oid));
  const newer = all.slice(0, index).findLast((commit) => shown.has(commit.oid));
  const toward =
    move === "down" || move === "parent" ? [older, newer] : [newer, older];
  return (toward[0] ?? toward[1])?.oid ?? null;
}

/**
 * The row a move selects among the loaded `rows`, newest first. Without a
 * loaded selection, `last` selects the oldest row and every other move the
 * newest. A move past either end, or off the loaded branch, keeps `selected`.
 */
export function nextRow(
  rows: readonly GraphNode[],
  graph: ReadonlyMap<RowId, GraphRow>,
  selected: RowId | null,
  move: Move,
): RowId | null {
  const index = rows.findIndex((row) => row.id === selected);
  const current = rows[index];
  if (current === undefined || move === "first" || move === "last")
    return (move === "last" ? rows.at(-1) : rows.at(0))?.id ?? null;
  switch (move) {
    case "up":
      return (rows[index - 1] ?? current).id;
    case "down":
      return (rows[index + 1] ?? current).id;
    case "parent": {
      const parent = current.parents.at(0);
      return parent !== undefined && graph.has(parent) ? parent : current.id;
    }
    case "child": {
      const child =
        lineChild(rows, graph, index) ??
        rows
          .slice(0, index)
          .findLast((row) => row.parents.at(0) === current.id);
      return child?.id ?? current.id;
    }
  }
}

function lineChild(
  rows: readonly GraphNode[],
  graph: ReadonlyMap<RowId, GraphRow>,
  index: number,
): GraphNode | undefined {
  const target = rows[index]?.id;
  for (let above = index - 1; above >= 0; above--) {
    const node = rows[above];
    const row = node && graph.get(node.id);
    if (!row) return undefined;
    const edge = row.parents.find((parent) => parent.oid === target);
    const straight = edge !== undefined && edge.from === edge.to;
    const firstParent = node.parents.at(0) === target;
    if (straight && firstParent) return node;
    if (row.continuations.some((lane) => lane.oid === target)) continue;
    return edge && firstParent ? node : undefined;
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
