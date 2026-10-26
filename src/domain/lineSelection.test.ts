import { describe, expect, it } from "vitest";
import {
  deletesNewFile,
  hunkAnchor,
  parsedFiles,
  picksFor,
  splittable,
} from "./lineSelection";
import type { LinePick } from "./repository";

const threeHunks = `diff --git a/app.ts b/app.ts
index 2e9afba84de88b1267f357a5d4580af453f809d9..be714465876b484bfde8cf124d49ced2fd951c5b 100644
--- a/app.ts
+++ b/app.ts
@@ -2,9 +2,9 @@ export const value1 = 1;
 export const value2 = 2;
 export const value3 = 3;
 export const value4 = 4;
-export const value5 = 5;
-export const value6 = 6;
-export const value7 = 7;
+export const five = 'five';
+export const six = 'six';
+export const sevenAndAHalf = 7.5;
 export const value8 = 8;
 export const value9 = 9;
 export const value10 = 10;
@@ -28,6 +28,8 @@ export const value27 = 27;
 export const value28 = 28;
 export const value29 = 29;
 export const value30 = 30;
+// a new comment
+export const inserted = true;
 export const value31 = 31;
 export const value32 = 32;
 export const value33 = 33;
@@ -46,7 +48,6 @@ export const value45 = 45;
 export const value46 = 46;
 export const value47 = 47;
 export const value48 = 48;
-export const value49 = 49;
 export const value50 = 50;
 export const value51 = 51;
 export const value52 = 52;
`;

const startsWithChange = `diff --git a/a.txt b/a.txt
index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644
--- a/a.txt
+++ b/a.txt
@@ -1,4 +1,4 @@
-one
+ONE
 two
 three
 four
`;

const created = `diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000000000000000000000000000000000000..3333333333333333333333333333333333333333
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,3 @@
+one
+two
+three
`;

function only(patch: string) {
  const [file, ...rest] = parsedFiles(patch);
  if (file === undefined || rest.length > 0) throw new Error("one file");
  return file;
}

const keys = (picks: LinePick[]) =>
  picks.map(({ side, line }) => `${side === "deletions" ? "d" : "a"}:${line}`);

const file = only(threeHunks);

describe("picksFor", () => {
  it("takes every deletion before the additions it reaches in Unified", () => {
    const range = {
      start: 5,
      side: "deletions" as const,
      end: 6,
      endSide: "additions" as const,
    };
    expect(keys(picksFor(file, "unified", range))).toEqual([
      "d:5",
      "d:6",
      "d:7",
      "a:5",
      "a:6",
    ]);
  });

  it("takes both halves of each row in Split", () => {
    const range = { start: 5, side: "deletions" as const, end: 7 };
    expect(keys(picksFor(file, "split", range))).toEqual([
      "d:5",
      "a:5",
      "d:6",
      "a:6",
      "d:7",
      "a:7",
    ]);
  });

  it("takes only additions when the range holds no deletion", () => {
    const range = { start: 30, side: "additions" as const, end: 33 };
    expect(keys(picksFor(file, "unified", range))).toEqual(["a:31", "a:32"]);
  });

  it("takes nothing from a range of context lines", () => {
    const range = { start: 2, side: "additions" as const, end: 4 };
    expect(picksFor(file, "unified", range)).toEqual([]);
  });

  it("orders a range picked from the bottom up", () => {
    const range = {
      start: 49,
      side: "deletions" as const,
      end: 47,
      endSide: "deletions" as const,
    };
    expect(keys(picksFor(file, "unified", range))).toEqual(["d:49"]);
  });
});

describe("hunkAnchor", () => {
  it("anchors on the last leading context line of the new file", () => {
    expect(hunkAnchor(file.hunks[0]!, 0)).toEqual({
      side: "additions",
      lineNumber: 4,
      metadata: { hunk: 0 },
    });
    expect(hunkAnchor(file.hunks[1]!, 1)).toEqual({
      side: "additions",
      lineNumber: 30,
      metadata: { hunk: 1 },
    });
  });

  it("leaves a hunk that starts with its change to the file header", () => {
    expect(hunkAnchor(only(startsWithChange).hunks[0]!, 0)).toBeNull();
    expect(hunkAnchor(only(created).hunks[0]!, 0)).toBeNull();
  });
});

describe("deletesNewFile", () => {
  const newFile = only(created);
  it("deletes a new file when the discard takes its hunk or every line", () => {
    expect(deletesNewFile(newFile, "hunk")).toBe(true);
    expect(
      deletesNewFile(newFile, [
        { side: "additions", line: 1 },
        { side: "additions", line: 2 },
        { side: "additions", line: 3 },
      ]),
    ).toBe(true);
  });

  it("keeps a new file when lines stay, and never deletes an edited file", () => {
    expect(deletesNewFile(newFile, [{ side: "additions", line: 2 }])).toBe(
      false,
    );
    expect(deletesNewFile(file, "hunk")).toBe(false);
  });
});

describe("splittable", () => {
  const link = `diff --git a/link b/link
index 1de565933b05f74c75ff9a6520af5f9f8a5a2f1d..27fa34919ae70aa0d7eaccdfbf393cfc440e7d25 120000
--- a/link
+++ b/link
@@ -1 +1 @@
-target-one
\\ No newline at end of file
+target-two
\\ No newline at end of file
`;
  const copy = `diff --git a/old.txt b/copy.txt
similarity index 80%
copy from old.txt
copy to copy.txt
index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644
--- a/old.txt
+++ b/copy.txt
@@ -1,2 +1,2 @@
 one
-two
+TWO
`;
  const typeChange = `diff --git a/x b/x
deleted file mode 120000
index 1111111111111111111111111111111111111111..0000000000000000000000000000000000000000
--- a/x
+++ /dev/null
@@ -1 +0,0 @@
-t
\\ No newline at end of file
diff --git a/x b/x
new file mode 100644
index 0000000000000000000000000000000000000000..2222222222222222222222222222222222222222
--- /dev/null
+++ b/x
@@ -0,0 +1 @@
+t
`;
  const modeOnly = `diff --git a/x.sh b/x.sh
old mode 100644
new mode 100755
`;

  it("splits a text edit, a new file, and a rename", () => {
    expect(splittable(threeHunks)).toBe(true);
    expect(splittable(created)).toBe(true);
    expect(
      splittable(
        threeHunks.replace(
          "index 2e9afba",
          "similarity index 90%\nrename from was.ts\nrename to app.ts\nindex 2e9afba",
        ),
      ),
    ).toBe(true);
  });

  it("refuses a link, a copy, a type change, and a patch with no hunk", () => {
    expect(splittable(link)).toBe(false);
    expect(splittable(copy)).toBe(false);
    expect(splittable(typeChange)).toBe(false);
    expect(splittable(modeOnly)).toBe(false);
  });

  it("refuses a patch whose lines disagree with its hunk header", () => {
    const blankContext = `diff --git a/wrong.txt b/wrong.txt
index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644
--- a/wrong.txt
+++ b/wrong.txt
@@ -1,6 +1,6 @@
 w1
${" "}
-w3
-w4
+W3
+W4
 w5
 w6
`;
    expect(splittable(blankContext)).toBe(true);
    expect(splittable(blankContext.replace("\n \n", "\n\n"))).toBe(false);
  });
});
