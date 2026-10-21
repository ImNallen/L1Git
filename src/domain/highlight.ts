import type { GraphNode, GraphRow, RowId } from "./graph";
import type { BranchStatus } from "./overview";
import type { Branch, Oid } from "./repository";

/** Which strokes of one graph row stay lit, index-aligned with its `GraphRow`. */
export type RowHighlight = {
  incoming: boolean;
  parents: boolean[];
  continuations: boolean[];
};

/** What one hovered branch tip affects: its commits and every graph stroke among them. */
export type BranchHighlight = {
  commits: Set<RowId>;
  rows: Map<RowId, RowHighlight>;
};

/**
 * Lights the branch ending at `tip`. Off the trunk, that is its own commits down
 * to the fork point plus every commit that merged or squash-merged them. On the
 * trunk, it is the whole first-parent chain.
 */
export function highlightBranch(
  nodes: readonly GraphNode[],
  rows: ReadonlyMap<RowId, GraphRow>,
  tip: Oid,
  trunk: readonly Oid[],
): BranchHighlight {
  const firstParent = new Map(
    nodes.map((node) => [node.id, node.parents.at(0)]),
  );
  const trunkChain = new Set<Oid>();
  for (let oid of trunk) {
    while (firstParent.has(oid) && !trunkChain.has(oid)) {
      trunkChain.add(oid);
      const parent = firstParent.get(oid);
      if (parent === undefined) break;
      oid = parent;
    }
  }

  const lit = new Set<RowId>();
  const litEdges = new Map<RowId, Set<number>>();
  const light = (child: RowId, index: number) =>
    litEdges.set(child, (litEdges.get(child) ?? new Set()).add(index));

  const onTrunk = trunkChain.has(tip);
  let current = tip;
  while (firstParent.has(current)) {
    lit.add(current);
    if (!onTrunk && trunkChain.has(current)) break;
    const parent = firstParent.get(current);
    if (parent === undefined || !firstParent.has(parent)) break;
    light(current, 0);
    current = parent;
  }

  const chain = new Set(lit);
  for (const [oid, row] of rows) {
    if (chain.has(oid)) continue;
    row.parents.forEach((edge, index) => {
      if (edge.oid !== firstParent.get(oid) && chain.has(edge.oid)) {
        lit.add(oid);
        light(oid, index);
      }
    });
  }

  const awaited = new Set<RowId>();
  const highlighted = new Map<RowId, RowHighlight>();
  for (const { id: oid } of nodes) {
    const row = rows.get(oid);
    if (!row) continue;
    const edges = litEdges.get(oid);
    highlighted.set(oid, {
      incoming: awaited.has(oid),
      continuations: row.continuations.map((edge) => awaited.has(edge.oid)),
      parents: row.parents.map((_, index) => edges?.has(index) ?? false),
    });
    row.parents.forEach((edge, index) => {
      if (edges?.has(index)) awaited.add(edge.oid);
    });
  }
  return { commits: lit, rows: highlighted };
}

/**
 * The commits the trunk ends at: the default branch and its upstream. Without a
 * default branch, a local `main` or `master` stands in.
 */
export function trunkTips(
  branches: readonly Branch[],
  statuses: readonly BranchStatus[],
): Oid[] {
  const status = statuses.find((branch) => branch.role === "default");
  const locals = branches.flatMap((branch) =>
    branch.kind === "local" ? [branch] : [],
  );
  const local =
    locals.find((branch) => branch.name === status?.name) ??
    locals.find((branch) => branch.name === "main") ??
    locals.find((branch) => branch.name === "master");
  if (!local) return [];
  const remote = branches.find(
    (branch) => branch.kind === "remote" && branch.reference === local.upstream,
  );
  return remote ? [local.oid, remote.oid] : [local.oid];
}
