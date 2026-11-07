import { describe, expect, it } from "vitest";
import { planLaneDraw } from "./graphIntro";
import type { LaneSegment } from "./graphIntro";

const span = (timing: { delay: number; duration: number }) => [
  timing.delay,
  timing.delay + timing.duration,
];
const rows = (lane: number, count: number, from = 0): LaneSegment[] =>
  Array.from({ length: count }, (_, row) => ({
    lane,
    top: (from + row) * 22,
    bottom: (from + row + 1) * 22,
  }));

describe("planLaneDraw", () => {
  it("draws three full-span lanes in the design's 100-580, 180-660 and 260-740 windows", () => {
    const timings = planLaneDraw([
      { lane: 0, top: 0, bottom: 220 },
      { lane: 1, top: 0, bottom: 220 },
      { lane: 2, top: 0, bottom: 220 },
    ]);
    const expected = [
      [100, 580],
      [180, 660],
      [260, 740],
    ];
    for (const [index, timing] of timings.entries()) {
      const [start, end] = span(timing);
      expect(start).toBeCloseTo(expected[index]?.[0] ?? NaN, 6);
      expect(end).toBeCloseTo(expected[index]?.[1] ?? NaN, 6);
    }
  });

  it("runs a lane's segments contiguously and in order down the lane", () => {
    const timings = planLaneDraw(rows(0, 8));
    expect(timings[0]?.delay).toBeCloseTo(100, 6);
    for (const [index, timing] of timings.slice(1).entries()) {
      const previous = timings[index];
      expect(timing.delay).toBeCloseTo(
        (previous?.delay ?? NaN) + (previous?.duration ?? NaN),
        6,
      );
      expect(timing.duration).toBeGreaterThan(0);
    }
    expect(span(timings.at(-1) ?? { delay: 0, duration: 0 })[1]).toBeCloseTo(
      580,
      6,
    );
  });

  it("eases out, so the top of a lane draws fastest", () => {
    const timings = planLaneDraw(rows(0, 8));
    expect(timings[0]?.duration ?? Infinity).toBeLessThan(
      timings.at(-1)?.duration ?? 0,
    );
  });

  it("finishes every lane by 740 however many lanes are visible", () => {
    const timings = planLaneDraw(
      Array.from({ length: 12 }, (_, lane) => rows(lane, 4)).flat(),
    );
    const ends = timings.map((timing) => span(timing)[1] ?? NaN);
    expect(Math.max(...ends)).toBeCloseTo(740, 6);
    expect(Math.min(...timings.map((timing) => timing.delay))).toBeCloseTo(
      100,
      6,
    );
  });

  it("uses each lane's own span, not the span of the whole graph", () => {
    const short = planLaneDraw([
      { lane: 0, top: 0, bottom: 440 },
      { lane: 1, top: 220, bottom: 264 },
    ])[1];
    const [start, end] = span(short ?? { delay: 0, duration: 0 });
    expect(start).toBeCloseTo(180, 6);
    expect(end).toBeCloseTo(660, 6);
  });

  it("ranks lanes among those visible, so a gap in lane numbers adds no delay", () => {
    const timings = planLaneDraw([
      { lane: 7, top: 0, bottom: 22 },
      { lane: 2, top: 0, bottom: 22 },
    ]);
    expect(timings[1]?.delay).toBeCloseTo(100, 6);
    expect(timings[0]?.delay).toBeCloseTo(180, 6);
  });

  it("plans nothing for no segments", () => {
    expect(planLaneDraw([])).toEqual([]);
  });
});
