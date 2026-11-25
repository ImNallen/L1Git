import { parsePatchFiles } from "@pierre/diffs";
import { describe, expect, it } from "vitest";
import type { ReviewThread } from "./pullRequest";
import type { RangeFile } from "./range";
import { oidSchema } from "./repository";
import {
  chipOf,
  commentsIn,
  elsewhereLabel,
  firstWords,
  placeThreads,
  threadsByFile,
} from "./reviewThreads";

const at = "2026-11-24T10:00:00Z";
const said = (by: string | null, body = "Why?") => ({ id: "C", by, at, body });
function thread(id: string, fields: Partial<ReviewThread> = {}): ReviewThread {
  return {
    id,
    review: null,
    path: "src/a.ts",
    line: 2,
    startLine: null,
    originalLine: 2,
    originalStartLine: null,
    side: "right",
    outdated: false,
    resolved: false,
    hunk: "",
    comments: { items: [said("sara")], total: 1 },
    ...fields,
  };
}

function file(path: string, from: string | null = null): RangeFile {
  return {
    path,
    from,
    status: from === null ? "M" : "R",
    similarity: from === null ? null : 94,
    added: 1,
    deleted: 1,
    oldBlob: oidSchema.parse("1".repeat(40)),
    newBlob: oidSchema.parse("2".repeat(40)),
    submodule: false,
  };
}

const parse = (patch: string) =>
  parsePatchFiles(patch).flatMap(({ files }) => files);

describe("threadsByFile", () => {
  it("follows a file that moved, unless another file is at its old path", () => {
    const moved = file("src/new.ts", "src/old.ts");
    const swapped = file("src/b.ts", "src/a.ts");
    const taken = file("src/a.ts");
    const threads = [
      thread("1", { path: "src/new.ts" }),
      thread("2", { path: "src/old.ts" }),
      thread("3", { path: "src/a.ts" }),
      thread("4", { path: "src/gone.ts" }),
    ];
    const found = threadsByFile([moved, swapped, taken], threads);
    const ids = (of: RangeFile) => found.get(of)?.map(({ id }) => id);
    expect(ids(moved)).toEqual(["1", "2"]);
    expect(ids(swapped)).toBeUndefined();
    expect(ids(taken)).toEqual(["3"]);
  });
});

const patch = parse(`diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,3 +20,4 @@
 one
-two
+TWO
+and
 three
`);

const typeChange = parse(`diff --git a/link b/link
deleted file mode 100644
index 1111111..0000000
--- a/link
+++ /dev/null
@@ -1,2 +0,0 @@
-one
-two
diff --git a/link b/link
new file mode 120000
index 0000000..2222222
--- /dev/null
+++ b/link
@@ -0,0 +1 @@
+target
\\ No newline at end of file
`);

describe("placeThreads", () => {
  const places = (threads: ReviewThread[], of = patch) => {
    const { onLines, elsewhere } = placeThreads(threads, of);
    return {
      lines: onLines.map((lines) =>
        lines.map(
          ({ side, lineNumber, metadata }) =>
            `${side} ${lineNumber}: ${metadata.join()}`,
        ),
      ),
      elsewhere: elsewhere.map(({ id }) => id).join(),
    };
  };

  it.each<[string, Partial<ReviewThread>, string | null]>([
    ["a line before the first", { line: 19 }, null],
    ["the first line, which did not change", { line: 20 }, "additions 20"],
    ["an added line", { line: 22 }, "additions 22"],
    ["the last line", { line: 23 }, "additions 23"],
    ["a line after the last", { line: 24 }, null],
    ["a line that went", { line: 11, side: "left" }, "deletions 11"],
    [
      "a line of before, which did not change",
      { line: 12, side: "left" },
      "deletions 12",
    ],
    ["a line of before, past its end", { line: 13, side: "left" }, null],
    ["an outdated line", { line: 21, outdated: true }, null],
    ["the whole file", { line: null }, null],
  ])("places a thread on %s", (_, fields, expected) => {
    expect(places([thread("t", fields)])).toEqual(
      expected === null
        ? { lines: [[]], elsewhere: "t" }
        : { lines: [[`${expected}: t`]], elsewhere: "" },
    );
  });

  it("keeps threads on one line together, in their order", () => {
    expect(
      places([
        thread("1", { line: 22 }),
        thread("2", { line: 11, side: "left" }),
        thread("3", { line: 22 }),
      ]).lines,
    ).toEqual([["additions 22: 1,3", "deletions 11: 2"]]);
  });

  it("finds the part of a changed type that has the line", () => {
    expect(
      places(
        [
          thread("old", { line: 2, side: "left" }),
          thread("new", { line: 1 }),
          thread("none", { line: 2 }),
        ],
        typeChange,
      ),
    ).toEqual({
      lines: [["deletions 2: old"], ["additions 1: new"]],
      elsewhere: "none",
    });
  });

  it("has no place in a file without lines", () => {
    expect(places([thread("t")], [])).toEqual({ lines: [], elsewhere: "t" });
  });
});

describe("what a thread says", () => {
  it("counts every comment, also the ones that are not shown", () => {
    const threads = [
      thread("1", { comments: { items: [said("sara")], total: 70 } }),
      thread("2"),
    ];
    expect(commentsIn(threads)).toBe(71);
    expect(elsewhereLabel(threads)).toBe(
      "71 comments that aren't on a line here",
    );
    expect(elsewhereLabel([thread("2")])).toBe(
      "1 comment that isn't on a line here",
    );
  });

  it.each([
    ["Cancel should  clear\nthe plan", "Cancel should clear the plan"],
    ["> quoted\n\nanswer", "quoted answer"],
    ["## **Title** `code`", "Title code"],
    ["- first\n- second", "first second"],
    ["<!-- bot -->\nHello", "Hello"],
    ["<!-- never closed", ""],
    [
      "See [the plan](docs/plan.md) and ![a shot](x.png)",
      "See the plan and a shot",
    ],
    ["```suggestion\nconst a = 1;\n```", "const a = 1;"],
    ["keep snake_case_names and a*b", "keep snake_case_names and ab"],
    ["", ""],
    ["x".repeat(200), `${"x".repeat(140)}…`],
    ["👩‍🚀".repeat(1), "👩‍🚀"],
    ["𝒳".repeat(141), `${"𝒳".repeat(140)}…`],
  ])("begins %j with %j", (body, expected) => {
    expect(firstWords(body)).toBe(expected);
  });

  it("reads the beginning of a body made to take long", () => {
    for (const body of [
      "<!--".repeat(1e5),
      "> ".repeat(1e5),
      "#".repeat(1e5),
      "[".repeat(1e5),
    ]) {
      const start = performance.now();
      firstWords(body);
      expect(performance.now() - start).toBeLessThan(50);
    }
  });

  it("names who spoke once each, and who spoke first", () => {
    const items = [
      said("octo", "First"),
      said("ada"),
      said("octo"),
      said(null),
      said("li"),
    ];
    expect(
      chipOf(thread("t", { comments: { items, total: 5 } }), "Octo"),
    ).toEqual({
      people: ["octo", "ada", null],
      count: "5 comments",
      by: "You",
      words: "First",
    });
    expect(
      chipOf(thread("t", { comments: { items: [], total: 1 } }), "octo"),
    ).toEqual({ people: [], count: "1 comment", by: null, words: "" });
  });
});
