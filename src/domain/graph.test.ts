import { describe, expect, it } from "vitest";
import { buildGraph } from "./graph";
import { oidSchema } from "./repository";

const a = oidSchema.parse("a".repeat(40));
const b = oidSchema.parse("b".repeat(40));
const c = oidSchema.parse("c".repeat(40));
const d = oidSchema.parse("d".repeat(40));
const e = oidSchema.parse("e".repeat(40));

describe("history graph", () => {
  it("draws both actual merge parents and rejoins their shared ancestor", () => {
    const graph = buildGraph([
      { oid: a, parents: [b, c] },
      { oid: b, parents: [d] },
      { oid: c, parents: [d] },
      { oid: d, parents: [] },
    ]);
    expect(graph.lanes).toBe(2);
    expect(graph.rows.get(a)).toEqual({
      oid: a,
      lane: 0,
      incoming: false,
      continuations: [],
      parents: [
        { oid: b, from: 0, to: 0 },
        { oid: c, from: 0, to: 1 },
      ],
    });
    expect(graph.rows.get(b)?.continuations).toEqual([
      { oid: c, from: 1, to: 1 },
    ]);
    expect(graph.rows.get(c)).toEqual({
      oid: c,
      lane: 1,
      incoming: true,
      continuations: [{ oid: d, from: 0, to: 0 }],
      parents: [{ oid: d, from: 1, to: 0 }],
    });
    expect(graph.rows.get(d)?.parents).toEqual([]);
  });

  it("keeps unrelated roots separate and retains a parent beyond the loaded boundary", () => {
    const graph = buildGraph([
      { oid: a, parents: [b] },
      { oid: c, parents: [] },
      { oid: b, parents: [e] },
    ]);
    expect(graph.rows.get(c)).toEqual({
      oid: c,
      lane: 1,
      incoming: false,
      continuations: [{ oid: b, from: 0, to: 0 }],
      parents: [],
    });
    expect(graph.rows.get(b)?.parents).toEqual([{ oid: e, from: 0, to: 0 }]);
    expect(graph.rows.has(e)).toBe(false);
    expect(buildGraph([])).toEqual({ rows: new Map(), lanes: 1 });
  });

  it("runs a squash commit's lane down into the tip of the branch it merged", () => {
    const graph = buildGraph(
      [
        { oid: a, parents: [b] },
        { oid: c, parents: [d] },
        { oid: b, parents: [d] },
        { oid: d, parents: [] },
      ],
      [{ tip: c, commit: a }],
    );
    expect(graph.lanes).toBe(2);
    expect(graph.rows.get(a)).toEqual({
      oid: a,
      lane: 0,
      incoming: false,
      continuations: [],
      parents: [
        { oid: b, from: 0, to: 0 },
        { oid: c, from: 0, to: 1 },
      ],
    });
    expect(graph.rows.get(c)).toEqual({
      oid: c,
      lane: 1,
      incoming: true,
      continuations: [{ oid: b, from: 0, to: 0 }],
      parents: [{ oid: d, from: 1, to: 1 }],
    });
    expect(graph.rows.get(b)).toEqual({
      oid: b,
      lane: 0,
      incoming: true,
      continuations: [{ oid: d, from: 1, to: 0 }],
      parents: [{ oid: d, from: 0, to: 0 }],
    });
  });
});
