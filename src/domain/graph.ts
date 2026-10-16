import type { Commit, Oid } from "./repository";

export type GraphRow = {
  oid: Oid;
  lane: number;
  incoming: boolean;
  continuations: { from: number; to: number }[];
  parents: { oid: Oid; from: number; to: number }[];
};

export function buildGraph(
  commits: readonly Pick<Commit, "oid" | "parents">[],
): { rows: Map<Oid, GraphRow>; lanes: number } {
  let lanes: Oid[] = [];
  let width = 1;
  const rows = new Map<Oid, GraphRow>();
  for (const commit of commits) {
    const incoming = lanes.includes(commit.oid);
    if (!incoming) lanes.push(commit.oid);
    const before = [...lanes];
    const lane = before.indexOf(commit.oid);
    const after = before.filter((oid) => oid !== commit.oid);
    let insertion = lane;
    for (const parent of commit.parents) {
      if (!after.includes(parent)) {
        after.splice(insertion, 0, parent);
        insertion++;
      }
    }
    const continuations = before.flatMap((oid, from) =>
      oid === commit.oid ? [] : [{ from, to: after.indexOf(oid) }],
    );
    const parents = commit.parents.map((oid) => ({
      oid,
      from: lane,
      to: after.indexOf(oid),
    }));
    rows.set(commit.oid, {
      oid: commit.oid,
      lane,
      incoming,
      continuations,
      parents,
    });
    width = Math.max(width, before.length, after.length);
    lanes = after;
  }
  return { rows, lanes: width };
}
