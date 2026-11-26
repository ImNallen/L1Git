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
  placeNotes,
  threadsByFile,
} from "./reviewThreads";
import type { Notes } from "./reviewThreads";
import { draftKey } from "./drafts";

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
    can: { reply: true, resolve: true, unresolve: false },
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
    oldMode: "100644",
    newMode: "100644",
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

const head = oidSchema.parse("1".repeat(40));
const older = oidSchema.parse("0".repeat(40));
const anchor = (line: number, side: "left" | "right" = "right") => ({
  kind: "line" as const,
  path: "src/a.ts",
  side,
  line,
  start: null,
});
const key = (line: number, at = head) => draftKey(anchor(line), at);
const nothing: Notes = { threads: [], drafts: [], sent: [], box: null };

describe("placeNotes", () => {
  const places = (notes: Partial<Notes>, of = patch) => {
    const { onLines, elsewhere } = placeNotes(
      { ...nothing, ...notes },
      head,
      of,
    );
    return {
      lines: onLines.map((lines) =>
        lines.map(
          ({ side, lineNumber, metadata: { threads, drafts, sent, box } }) =>
            `${side} ${lineNumber}: ${[
              ...threads,
              ...drafts.map(() => "draft"),
              ...sent,
              ...(box ? ["box"] : []),
            ].join()}`,
        ),
      ),
      elsewhere: [
        ...elsewhere.threads.map(({ id }) => id),
        ...elsewhere.drafts.map(() => "draft"),
        ...elsewhere.sent,
      ].join(),
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
    expect(places({ threads: [thread("t", fields)] })).toEqual(
      expected === null
        ? { lines: [[]], elsewhere: "t" }
        : { lines: [[`${expected}: t`]], elsewhere: "" },
    );
  });

  it("keeps threads on one line together, in their order", () => {
    expect(
      places({
        threads: [
          thread("1", { line: 22 }),
          thread("2", { line: 11, side: "left" }),
          thread("3", { line: 22 }),
        ],
      }).lines,
    ).toEqual([["additions 22: 1,3", "deletions 11: 2"]]);
  });

  it("finds the part of a changed type that has the line", () => {
    expect(
      places(
        {
          threads: [
            thread("old", { line: 2, side: "left" }),
            thread("new", { line: 1 }),
            thread("none", { line: 2 }),
          ],
        },
        typeChange,
      ),
    ).toEqual({
      lines: [["deletions 2: old"], ["additions 1: new"]],
      elsewhere: "none",
    });
  });

  it("has no place in a file without lines", () => {
    expect(places({ threads: [thread("t")] }, [])).toEqual({
      lines: [],
      elsewhere: "t",
    });
  });

  it.each<[string, Partial<Notes>, ReturnType<typeof places>]>([
    [
      "a pending comment on its last line, after the threads there",
      {
        threads: [thread("t", { line: 22 })],
        drafts: [{ key: key(22), anchor: anchor(22), head }],
      },
      { lines: [["additions 22: t,draft"]], elsewhere: "" },
    ],
    [
      "a pending comment of an older head elsewhere, though its line is drawn",
      { drafts: [{ key: key(22, older), anchor: anchor(22), head: older }] },
      { lines: [[]], elsewhere: "draft" },
    ],
    [
      "a pending comment on a line that isn't drawn elsewhere",
      { drafts: [{ key: key(40), anchor: anchor(40), head }] },
      { lines: [[]], elsewhere: "draft" },
    ],
    [
      "a sent comment on its line, and one sent at another commit elsewhere",
      {
        sent: [
          { id: "now", lines: anchor(21), commit: head },
          { id: "then", lines: anchor(21), commit: older },
        ],
      },
      { lines: [["additions 21: now"]], elsewhere: "then" },
    ],
    [
      "the box under its range, holding its own words and its own send",
      {
        drafts: [{ key: key(22), anchor: anchor(22), head }],
        sent: [{ id: "mine", lines: anchor(22), commit: head }],
        box: { anchor: anchor(22), attempt: "mine" },
      },
      { lines: [["additions 22: box"]], elsewhere: "" },
    ],
    [
      "the box beside another pending comment on its line",
      {
        drafts: [{ key: key(11), anchor: anchor(11, "left"), head }],
        box: { anchor: anchor(22), attempt: null },
      },
      { lines: [["deletions 11: draft", "additions 22: box"]], elsewhere: "" },
    ],
  ])("places %s", (_, notes, expected) => {
    expect(places(notes)).toEqual(expected);
  });
});

describe("what a thread says", () => {
  it("counts every comment, also the ones that are not shown", () => {
    const threads = [
      thread("1", { comments: { items: [said("sara")], total: 70 } }),
      thread("2"),
    ];
    expect(commentsIn(threads)).toBe(71);
    const none = { threads: [], drafts: [], sent: [] };
    expect(elsewhereLabel({ ...none, threads })).toBe(
      "71 comments that aren't on a line here",
    );
    expect(elsewhereLabel({ ...none, threads: [thread("2")] })).toBe(
      "1 comment that isn't on a line here",
    );
    expect(
      elsewhereLabel({ threads: [], drafts: [key(2)], sent: ["sent"] }),
      "a pending comment and a sent one count too",
    ).toBe("2 comments that aren't on a line here");
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
