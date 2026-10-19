import type { Commit, Oid, Squash } from "./repository";

export type GraphRow = {
  oid: Oid;
  lane: number;
  incoming: boolean;
  continuations: { oid: Oid; from: number; to: number }[];
  parents: { oid: Oid; from: number; to: number }[];
};

export function buildGraph(
  commits: readonly Pick<Commit, "oid" | "parents">[],
  squashes: readonly Squash[] = [],
): { rows: Map<Oid, GraphRow>; lanes: number } {
  const squashed = new Map<Oid, Oid[]>();
  for (const { commit, tip } of squashes) {
    squashed.set(commit, [...(squashed.get(commit) ?? []), tip]);
  }
  let lanes: Oid[] = [];
  let width = 1;
  const rows = new Map<Oid, GraphRow>();
  for (const commit of commits) {
    const incoming = lanes.includes(commit.oid);
    if (!incoming) lanes.push(commit.oid);
    const before = [...lanes];
    const lane = before.indexOf(commit.oid);
    const after = before.filter((oid) => oid !== commit.oid);
    const tips = squashed.get(commit.oid) ?? [];
    const parents = [...commit.parents, ...tips];
    let insertion = lane;
    for (const parent of parents) {
      if (!after.includes(parent)) {
        after.splice(insertion, 0, parent);
        insertion++;
      }
    }
    const continuations = before.flatMap((oid, from) =>
      oid === commit.oid ? [] : [{ oid, from, to: after.indexOf(oid) }],
    );
    rows.set(commit.oid, {
      oid: commit.oid,
      lane,
      incoming,
      continuations,
      parents: parents.map((oid) => ({
        oid,
        from: lane,
        to: after.indexOf(oid),
      })),
    });
    width = Math.max(width, before.length, after.length);
    lanes = after;
  }
  return { rows, lanes: width };
}
