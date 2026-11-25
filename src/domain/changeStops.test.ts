import { parsePatchFiles } from "@pierre/diffs";
import { describe, expect, it, vi } from "vitest";
import { changeStops, nextChange } from "./changeStops";

const stops = (patch: string) =>
  changeStops(parsePatchFiles(patch).flatMap(({ files }) => files)).map(
    ({ part, side, line }) => `${part} ${side} ${line}`,
  );

describe("changeStops", () => {
  it("finds the first line of each change, the old one when there is one", () => {
    expect(
      stops(`--- a/a
+++ b/a
@@ -10,6 +10,7 @@
 one
-two
+TWO
 three
+more
 four
-five
 six
@@ -40,2 +41,3 @@
+first
 one
 two
`),
    ).toEqual([
      "0 deletions 11",
      "0 additions 13",
      "0 deletions 14",
      "0 additions 41",
    ]);
  });

  it("counts both parts of a changed type", () => {
    expect(
      stops(`diff --git a/link b/link
deleted file mode 100644
index 1111111..0000000
--- a/link
+++ /dev/null
@@ -1 +0,0 @@
-one
diff --git a/link b/link
new file mode 120000
index 0000000..2222222
--- /dev/null
+++ b/link
@@ -0,0 +1 @@
+target
`),
    ).toEqual(["0 deletions 1", "1 additions 1"]);
  });
});

describe("nextChange", () => {
  const tops = [66, 500, 900, 1960, 2000];
  const to = (
    of: readonly number[],
    view: Parameters<typeof nextChange>[2],
    by: 1 | -1,
  ) =>
    nextChange(of.length, (change) => of[change]!, view, by)?.scrollTop ?? null;
  const view = (at: number) => ({ at, most: 1500, above: 66 });
  it.each([
    ["next", 0, 1, 434],
    ["next", 434, 1, 834],
    ["next, also after a scroll by hand", 600, 1, 834],
    ["next, at the end", 834, 1, 1500],
    ["next, when the rest is in view", 1500, 1, null],
    ["before", 1500, -1, 834],
    ["before, also after a scroll by hand", 700, -1, 434],
    ["before", 434, -1, 0],
    ["before, at the beginning", 0, -1, null],
  ] as const)("finds the %s from %i", (_, at, by, expected) => {
    expect(to(tops, view(at), by)).toBe(expected);
  });

  it("moves nothing in a file that fits or has no change", () => {
    expect(to([66, 200], { at: 0, most: 0, above: 66 }, 1)).toBeNull();
    expect(to([], view(0), 1)).toBeNull();
    expect(to([], view(0), -1)).toBeNull();
  });

  it("asks for few of many places", () => {
    const topOf = vi.fn((change: number) => 100 + change * 50);
    const end = { at: 100_000, most: 300_000, above: 66 };
    expect(nextChange(4_000, topOf, end, 1)).toEqual({
      change: 2_000,
      scrollTop: 100_034,
    });
    expect(nextChange(4_000, topOf, end, -1)?.scrollTop).toBe(99_984);
    expect(topOf.mock.calls.length).toBeLessThan(40);
  });
});
