import type { Oid, RepositoryRoot, Squash } from "./repository";

export type WorktreeRowId = `worktree:${RepositoryRoot}`;
export type RowId = Oid | WorktreeRowId;

export function worktreeRowId(root: RepositoryRoot): WorktreeRowId {
  return `worktree:${root}`;
}

export type GraphNode = { id: RowId; parents: readonly Oid[] };

export type GraphRow = {
  id: RowId;
  lane: number;
  incoming: boolean;
  continuations: { oid: Oid; from: number; to: number }[];
  parents: { oid: Oid; from: number; to: number }[];
};

export type Graph = { rows: Map<RowId, GraphRow>; lanes: number };

export function buildGraph(
  nodes: readonly GraphNode[],
  squashes: readonly Squash[] = [],
): Graph {
  const squashed = new Map<RowId, Oid[]>();
  for (const { commit, tip } of squashes) {
    squashed.set(commit, [...(squashed.get(commit) ?? []), tip]);
  }
  let lanes: Oid[] = [];
  let width = 1;
  const rows = new Map<RowId, GraphRow>();
  for (const node of nodes) {
    const found = lanes.findIndex((oid) => oid === node.id);
    const incoming = found >= 0;
    const lane = incoming ? found : lanes.length;
    const after = lanes.filter((oid) => oid !== node.id);
    const parents = [...node.parents, ...(squashed.get(node.id) ?? [])];
    let insertion = lane;
    for (const parent of parents) {
      if (!after.includes(parent)) {
        after.splice(insertion, 0, parent);
        insertion++;
      }
    }
    const continuations = lanes.flatMap((oid, from) =>
      oid === node.id ? [] : [{ oid, from, to: after.indexOf(oid) }],
    );
    rows.set(node.id, {
      id: node.id,
      lane,
      incoming,
      continuations,
      parents: parents.map((oid) => ({
        oid,
        from: lane,
        to: after.indexOf(oid),
      })),
    });
    width = Math.max(width, lanes.length + (incoming ? 0 : 1), after.length);
    lanes = after;
  }
  return { rows, lanes: width };
}
