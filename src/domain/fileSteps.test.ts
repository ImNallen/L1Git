import { describe, expect, it, vi } from "vitest";
import { furtherStep, stepFrom, stepInView } from "./fileSteps";
import type { FileStep } from "./fileSteps";

const told = (step: FileStep | null) =>
  step && `${step.file}.${step.change ?? "unread"}`;

const of = (counts: readonly (number | null)[]) => (file: number) =>
  counts[file];

describe("stepFrom", () => {
  const counts = of([2, 0, 3, null, 1]);
  it.each([
    [0, -1, 1, "0.0"],
    [0, 0, 1, "0.1"],
    [0, 1, 1, "2.0"],
    [1, 0, 1, "2.0"],
    [2, 2, 1, "3.unread"],
    [3, -1, 1, "3.unread"],
    [4, 0, 1, null],
    [4, 1, -1, "4.0"],
    [4, 0, -1, "3.unread"],
    [2, 3, -1, "2.2"],
    [2, 0, -1, "0.1"],
    [0, 0, -1, null],
    [9, 0, 1, null],
  ] as const)("goes from %i.%i by %i", (file, change, by, expected) => {
    expect(told(stepFrom(counts, { file, change }, by))).toBe(expected);
  });

  it("visits each once, and each once on the way back", () => {
    const some = of([2, 0, 3, 1]);
    const walk = (from: FileStep, by: 1 | -1) => {
      const out: (string | null)[] = [];
      let at: FileStep | null = from;
      while (at) {
        at = stepFrom(some, { file: at.file, change: at.change ?? 0 }, by);
        if (at) out.push(told(at));
      }
      return out;
    };
    const all = ["0.0", "0.1", "2.0", "2.1", "2.2", "3.0"];
    expect(walk({ file: 0, change: -1 }, 1)).toEqual(all);
    expect(walk({ file: 3, change: 1 }, -1)).toEqual([...all].reverse());
  });
});

describe("stepInView", () => {
  /** Where the view begins for each step to files 1 to 3. The rest isn't drawn. */
  const tops = [[], [-50, 10, 100], [], [160, 400]];
  const counts = of([2, 3, 0, 2, 5]);
  const view = (at: number, file = 1) => ({ first: 1, last: 3, file, at });
  const topOf = ({ file, change }: FileStep) => tops[file]![change ?? 0]!;
  it.each([
    [0, 1, "1.1"],
    [10, 1, "1.2"],
    [40, 1, "1.2"],
    [130, 1, "3.0"],
    // The view begins in a file before the one of the change it is at.
    [160, 1, "3.1"],
    [400, 1, "4.0"],
    [999, 1, "4.0"],
    [400, -1, "3.0"],
    [160, -1, "1.2"],
    [100, -1, "1.1"],
    [10, -1, "1.0"],
    [-50, -1, "0.1"],
  ] as const)("goes from %i by %i", (at, by, expected) => {
    expect(told(stepInView(counts, view(at), topOf, by))).toBe(expected);
  });

  it("stops at a file that is not read", () => {
    const unread = of([2, null, 0, 2, 5]);
    const top = ({ file }: FileStep) => (file === 1 ? 50 : 160);
    const step = (at: number, by: 1 | -1, file: number) =>
      told(stepInView(unread, view(at, file), top, by));
    expect(step(0, 1, 0)).toBe("1.unread");
    expect(step(80, 1, 1), "it is in it").toBe("1.unread");
    expect(step(90, 1, 2), "it is past it").toBe("3.0");
    expect(step(50, -1, 1)).toBe("0.1");
    expect(step(90, -1, 2)).toBe("1.unread");
  });

  it("asks for few of many places", () => {
    const places = vi.fn(({ change }: FileStep) => (change ?? 0) * 50);
    const one = { first: 0, last: 0, file: 0, at: 100_000 };
    expect(stepInView(of([4_000]), one, places, 1)).toEqual({
      file: 0,
      change: 2_001,
    });
    expect(stepInView(of([4_000]), one, places, -1)).toEqual({
      file: 0,
      change: 1_999,
    });
    expect(places.mock.calls.length).toBeLessThan(40);
  });
});

it("tells which of two steps is further", () => {
  const near = { file: 1, change: 2 };
  for (const far of [
    { file: 1, change: 3 },
    { file: 2, change: null },
  ]) {
    expect(furtherStep(near, far, 1)).toBe(far);
    expect(furtherStep(far, near, 1)).toBe(far);
    expect(furtherStep(near, far, -1)).toBe(near);
  }
  expect(furtherStep(null, near, 1)).toBe(near);
  expect(furtherStep(near, null, -1)).toBe(near);
  expect(furtherStep(null, null, 1)).toBeNull();
});
