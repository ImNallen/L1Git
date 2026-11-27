import { parsePatchFiles } from "@pierre/diffs";
import type { SelectedLineRange } from "@pierre/diffs";
import { describe, expect, it } from "vitest";
import { draftKey } from "./drafts";
import {
  carriedBy,
  linesLabel,
  placeOf,
  rangeOf,
  runAt,
  sinceRefusal,
} from "./lineComments";
import type { Lines } from "./lineComments";
import type { RangeFile } from "./range";
import { oidSchema } from "./repository";
import type { DiffStyle } from "./lineSelection";

const [file] = parsePatchFiles(`diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,4 +10,5 @@
 one
-two
-three
+TWO
+THREE
+and
 four
@@ -30,2 +31,3 @@
 thirty
+inserted
 thirty-one
`).flatMap(({ files }) => files);

const range = (
  start: number,
  end: number,
  side: "deletions" | "additions" = "additions",
  endSide = side,
): SelectedLineRange => ({ start, side, end, endSide });

describe("placeOf", () => {
  it.each<[string, DiffStyle, SelectedLineRange, string | null]>([
    ["one added line", "unified", range(11, 11), "right 11"],
    ["one deleted line", "unified", range(12, 12, "deletions"), "left 12"],
    ["a context line, on its new side", "unified", range(14, 14), "right 14"],
    [
      "a range from a deletion to an addition",
      "unified",
      range(11, 12, "deletions", "additions"),
      "left 11 to right 12",
    ],
    [
      "a range dragged upward",
      "unified",
      range(13, 11),
      "right 11 to right 13",
    ],
    [
      "a range that runs past the hunk, cut at its end",
      "unified",
      range(12, 20),
      "right 12 to right 14",
    ],
    [
      "a range over two hunks, cut to the one it ends in",
      "unified",
      range(13, 32),
      "right 31 to right 32",
    ],
    ["expanded lines between hunks", "unified", range(20, 25), null],
    [
      "a row of both sides in Split, on the side chosen",
      "split",
      range(11, 11, "deletions"),
      "left 11",
    ],
    [
      "a range of rows in Split, ends on their sides",
      "split",
      range(11, 12, "deletions", "additions"),
      "left 11 to right 12",
    ],
  ])("places %s", (_, style, chosen, expected) => {
    const anchor = placeOf(file!, style, "src/a.ts", chosen);
    expect(
      anchor &&
        (anchor.start === null
          ? `${anchor.side} ${anchor.line}`
          : `${anchor.start.side} ${anchor.start.line} to ${anchor.side} ${anchor.line}`),
    ).toBe(expected);
    if (anchor) expect(anchor.path).toBe("src/a.ts");
  });

  it("highlights again the lines it placed", () => {
    for (const chosen of [range(11, 13), range(12, 12, "deletions")]) {
      const anchor = placeOf(file!, "unified", "src/a.ts", chosen)!;
      expect(placeOf(file!, "unified", "src/a.ts", rangeOf(anchor))).toEqual(
        anchor,
      );
    }
  });
});

describe("runAt", () => {
  it.each<[string, { side: "deletions" | "additions"; line: number }, string]>([
    [
      "a run of deletions and additions",
      { side: "deletions", line: 11 },
      "deletions 11 to additions 13",
    ],
    [
      "a run of additions only",
      { side: "additions", line: 32 },
      "additions 32 to additions 32",
    ],
  ])("takes %s", (_, begin, expected) => {
    const found = runAt(file!, begin);
    expect(
      found && `${found.side} ${found.start} to ${found.endSide} ${found.end}`,
    ).toBe(expected);
  });

  it("finds no run where none begins", () => {
    expect(runAt(file!, { side: "additions", line: 12 })).toBeNull();
  });
});

it("names the lines of a comment", () => {
  expect(linesLabel({ line: 11, start: null })).toBe("line 11");
  expect(linesLabel({ line: 102, start: { side: "right", line: 100 } })).toBe(
    "lines 100–102",
  );
});

it("names the drafts a write carries, at the commit it is about", () => {
  const commit = oidSchema.parse("1".repeat(40));
  const lines = {
    path: "a.ts",
    side: "right" as const,
    line: 12,
    start: { side: "right" as const, line: 10 },
  };
  const key = draftKey({ kind: "line", ...lines }, commit);
  const pull = "PR_1" as never;
  expect(
    carriedBy({ kind: "singleComment", pull, commit, lines, body: "a" }),
  ).toEqual([key]);
  expect(
    carriedBy({
      kind: "submitReview",
      pull,
      commit,
      event: "comment",
      body: "",
      threads: [{ lines, body: "a" }],
    }),
  ).toEqual([key]);
  expect(carriedBy({ kind: "comment", pull, body: "a" })).toEqual([]);
});

describe("sinceRefusal", () => {
  const now = { path: "src/a.ts" } as RangeFile;
  const own = {
    kind: "text",
    lossy: false,
    patch:
      "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -10,4 +10,5 @@\n one\n-two\n+TWO\n three\n@@ -30,2 +31,3 @@\n thirty\n+inserted\n",
  } as const;
  const lines = (
    line: number,
    start: number | null = null,
    side: "left" | "right" = "right",
  ): Lines => ({
    path: "src/a.ts",
    side,
    line,
    start: start === null ? null : { side, line: start },
  });

  it("takes new lines inside one hunk of the pull request's own patch", () => {
    expect(sinceRefusal(lines(14, 10), now, own)).toBeNull();
    expect(sinceRefusal(lines(33), now, own)).toBeNull();
  });

  it("refuses lines outside its hunks, or across two of them", () => {
    expect(sinceRefusal(lines(20), now, own)).toMatch(/^GitHub takes/);
    expect(sinceRefusal(lines(31, 14), now, own)).toMatch(/^GitHub takes/);
  });

  it("refuses old lines, which are of a commit GitHub has never seen", () => {
    expect(sinceRefusal(lines(11, null, "left"), now, own)).toBe(
      "In Since your last review, comments go on new lines. Switch to All changes to comment on old ones.",
    );
  });

  it("refuses a file the pull request no longer changes, and leaves the rest to GitHub without its patch", () => {
    expect(sinceRefusal(lines(11), null, own)).toMatch(/no longer changes/);
    expect(sinceRefusal(lines(99), now, null)).toBeNull();
  });
});
