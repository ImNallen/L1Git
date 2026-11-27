import { parsePatchFiles } from "@pierre/diffs";
import { describe, expect, it, vi } from "vitest";
import { changeAt, changeStops, nextChange, partOf } from "./changeStops";

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

  it("stops once at a run whose lines Pierre pairs", () => {
    const [file] = parsePatchFiles(`--- a/a
+++ b/a
@@ -1,2 +1,3 @@
 const ok = 1;
-const x = 2;
+if (x) { begin }
+const z = 2;
`)[0]!.files;
    const [hunk] = file!.hunks;
    expect(hunk!.hunkContent.map(({ type }) => type)).toEqual([
      "context",
      "change",
      "change",
    ]);
    expect(changeStops([file!])).toEqual([
      { part: 0, side: "additions", line: 2 },
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

  it.each([
    [0, 0],
    [434, 1],
    [600, 2],
    [1500, 3],
  ])("is at a change from %i", (at, expected) => {
    expect(changeAt(tops.length, (change) => tops[change]!, view(at))).toBe(
      expected,
    );
  });

  it("is at no change when every one is above the view", () => {
    expect(changeAt(2, (change) => [10, 20][change]!, view(900))).toBeNull();
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

describe("partOf", () => {
  // A file that became a symlink: the patch's two halves are two parts.
  const parts = parsePatchFiles(`diff --git a/link b/link
deleted file mode 100644
--- a/link
+++ /dev/null
@@ -1,2 +0,0 @@
-one
-two
diff --git a/link b/link
new file mode 120000
--- /dev/null
+++ b/link
@@ -0,0 +1 @@
+target
`).flatMap(({ files }) => files);

  it("finds the part whose hunks hold a line, whatever part was named", () => {
    expect(parts).toHaveLength(2);
    expect(partOf(parts, { part: 0, side: "additions", number: 1 })).toBe(1);
    expect(partOf(parts, { part: 1, side: "deletions", number: 2 })).toBe(0);
    expect(partOf(parts, { part: 1, side: "additions", number: 1 })).toBe(1);
  });

  it("keeps the part named when no hunk holds the line", () => {
    expect(partOf(parts, { part: 1, side: "deletions", number: 9 })).toBe(1);
    expect(partOf([], { part: 0, side: "additions", number: 1 })).toBe(0);
  });
});
