import { describe, expect, it } from "vitest";
import { parsePatchFiles } from "@pierre/diffs";
import { patchText, sidesFor } from "./fileSides";

const header = `diff --git a/a.txt b/a.txt
index e031777e6dd8bb5a9b38f0bba64a38e5ec76b92d..73b32b45d6a5fb5c753f4f5e83397b3640142ab9 100644
--- a/a.txt
+++ b/a.txt
`;

const twoHunks = `${header}@@ -1,5 +1,5 @@
 one
-two
+TWO
 three
 four
 five
@@ -8,5 +8,5 @@ seven
 eight
 nine
 ten
-eleven
+ELEVEN
 twelve
`;

const whole = `${header}@@ -1,12 +1,12 @@
 one
-two
+TWO
 three
 four
 five
 six
 seven
 eight
 nine
 ten
-eleven
+ELEVEN
 twelve
`;

const noNewlineHeader = `diff --git a/b.txt b/b.txt
index f5ef1703d1140601ba70dbf271af1fe920f1d454..77e29b969b533cb1ac86063522dee454b0efa9f4 100644
--- a/b.txt
+++ b/b.txt
`;

const noNewlineHunks = `${noNewlineHeader}@@ -1,4 +1,4 @@
-one
+ONE
 two
 three
 four
@@ -7,4 +7,4 @@ six
 seven
 eight
 nine
-ten
\\ No newline at end of file
+TEN
\\ No newline at end of file
`;

const noNewlineWhole = `${noNewlineHeader}@@ -1,10 +1,10 @@
-one
+ONE
 two
 three
 four
 five
 six
 seven
 eight
 nine
-ten
\\ No newline at end of file
+TEN
\\ No newline at end of file
`;

function shown(patch: string) {
  const [file] = parsePatchFiles(patch).flatMap((parsed) => parsed.files);
  if (file === undefined) throw new Error("one file");
  return file;
}

describe("sidesFor", () => {
  it("rebuilds both sides of the file from the whole-file patch", () => {
    expect(sidesFor(shown(twoHunks), whole)).toEqual({
      oldFile: {
        name: "a.txt",
        contents:
          "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\ntwelve\n",
      },
      newFile: {
        name: "a.txt",
        contents:
          "one\nTWO\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\nELEVEN\ntwelve\n",
      },
    });
  });

  it("keeps a missing final newline on both sides", () => {
    expect(sidesFor(shown(noNewlineHunks), noNewlineWhole)).toEqual({
      oldFile: {
        name: "b.txt",
        contents: "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten",
      },
      newFile: {
        name: "b.txt",
        contents: "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nTEN",
      },
    });
  });

  it("refuses sides that changed after the shown diff was read", () => {
    const edited = whole.replace("+ELEVEN", "+Eleven");
    expect(() => sidesFor(shown(twoHunks), edited)).toThrow();
    const moved = whole
      .replace(" six\n", " six\n+new\n")
      .replace("@@ -1,12 +1,12 @@", "@@ -1,12 +1,13 @@");
    expect(() => sidesFor(shown(twoHunks), moved)).toThrow();
  });

  it("refuses a whole-file patch for another file", () => {
    expect(() => sidesFor(shown(twoHunks), noNewlineWhole)).toThrow();
  });
});

describe("patchText", () => {
  it("reads a text diff and refuses any other", () => {
    expect(patchText({ kind: "text", patch: whole, lossy: false })).toBe(whole);
    expect(() => patchText({ kind: "binary" })).toThrow();
    expect(() => patchText(null)).toThrow();
  });
});
