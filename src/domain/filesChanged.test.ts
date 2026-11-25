import { describe, expect, it } from "vitest";
import {
  distinctPaths,
  inPlaceOfLines,
  inTreeOrder,
  lineTotals,
  newerThan,
  pathLabel,
  rangeOf,
  statusWord,
  stopText,
} from "./filesChanged";
import type { Stop } from "./filesChanged";
import type { TimelineEvent } from "./pullRequest";
import { rangeFilesSchema } from "./range";
import type { RangeFile } from "./range";
import { oidSchema, rootSchema } from "./repository";
import type { FilePatch } from "./repository";

const oid = (digit: string) => oidSchema.parse(digit.repeat(40));
const github = { owner: "nordic", repo: "l1-git" };
const repository = {
  key: "nordic/l1-git",
  name: "L1 Git",
  root: rootSchema.parse("/work/l1-git"),
  github,
};

function file(path: string, fields: Partial<RangeFile> = {}): RangeFile {
  const answer = rangeFilesSchema.parse({
    kind: "ready",
    mergeBase: oid("a"),
    contentMissing: false,
    files: [
      {
        path,
        status: "M",
        from: null,
        similarity: null,
        added: 1,
        deleted: 1,
        oldBlob: oid("1"),
        newBlob: oid("2"),
        submodule: false,
        ...fields,
      },
    ],
  });
  if (answer.kind !== "ready") throw new Error("not ready");
  return answer.files[0]!;
}

const happened = { id: "E", at: "2026-11-24T10:00:00Z" };
const commit = (by: string | null, of: string): TimelineEvent => ({
  ...happened,
  kind: "commit",
  oid: oid(of),
  headline: "",
  by,
});
const forced = (by: string | null, to: string | null): TimelineEvent => ({
  ...happened,
  kind: "forcePushed",
  from: null,
  to: to && oid(to),
  by,
});
function pull(base: string, head: string, events: TimelineEvent[] = []) {
  return {
    base,
    baseOid: oid("b"),
    head: {
      branch: "topic",
      oid: oid(head),
      repository: github,
      crossRepository: false,
      maintainerCanModify: false,
    },
    timeline: { items: events, total: events.length },
  };
}

describe("rangeOf", () => {
  it("pins the clone, the base, and the head", () => {
    expect(rangeOf(repository, pull("main", "1"))).toEqual({
      repository,
      base: "main",
      baseOid: oid("b"),
      head: oid("1"),
    });
  });
});

describe("newerThan", () => {
  const range = rangeOf(repository, pull("main", "1"));
  it.each([
    ["the same", pull("main", "1"), null],
    ["a base that moved", { ...pull("main", "1"), baseOid: oid("c") }, null],
    [
      "commits",
      pull("main", "2", [commit("ada", "1"), commit("maja", "2")]),
      { text: "maja pushed new commits.", show: "Show them" },
    ],
    [
      "the viewer's commits",
      pull("main", "2", [commit("Octo", "2")]),
      { text: "You pushed new commits.", show: "Show them" },
    ],
    [
      "a force push, whoever wrote the commit",
      pull("main", "2", [commit("ada", "2"), forced("maja", "2")]),
      { text: "maja pushed new commits.", show: "Show them" },
    ],
    [
      "commits that the timeline leaves out",
      pull("main", "2", [commit("ada", "1"), forced("maja", null)]),
      { text: "New commits were pushed.", show: "Show them" },
    ],
    [
      "commits of nobody GitHub knows",
      pull("main", "2", [commit(null, "2")]),
      { text: "New commits were pushed.", show: "Show them" },
    ],
    [
      "another base",
      pull("next", "1"),
      { text: "The base changed to next.", show: "Show it" },
    ],
    [
      "commits and another base",
      pull("next", "2", [commit("maja", "2")]),
      {
        text: "maja pushed new commits, and the base changed to next.",
        show: "Show them",
      },
    ],
  ])("tells %s", (_, newer, expected) => {
    expect(newerThan(range, newer, "octo")).toEqual(expected);
  });
});

describe("stopText", () => {
  it.each<[Stop, string, boolean, boolean]>([
    [
      { kind: "unrelated", shallow: true },
      "This is a shallow clone, and the commit where this pull request starts isn't in it.",
      true,
      false,
    ],
    [
      { kind: "unrelated", shallow: false },
      "This pull request and its base have no commit in common.",
      false,
      false,
    ],
    [
      { kind: "stillMissing" },
      "GitHub answered, but the commits still aren't in this clone.",
      true,
      false,
    ],
    [
      { kind: "noRemote" },
      "This clone has no remote for nordic/l1-git.",
      true,
      false,
    ],
    [
      { kind: "failed", failure: "auth", message: "Permission denied." },
      "Authentication failed. Permission denied.",
      true,
      false,
    ],
    [
      {
        kind: "unreadable",
        problem: { kind: "missingPath", message: "The folder is gone." },
      },
      "The folder is gone.",
      true,
      false,
    ],
    [
      {
        kind: "unreadable",
        problem: { kind: "gitFailed", message: "fatal: bad object" },
      },
      "fatal: bad object",
      true,
      true,
    ],
  ])("says why for %j", (stop, detail, retry, verbatim) => {
    expect(stopText(stop, github)).toMatchObject({ detail, retry, verbatim });
  });
});

describe("the list of files", () => {
  it("is in the order of the tree, folders first", () => {
    const files = ["README.md", "src/a.ts", "src/b/c.ts", "a10", "a9"].map(
      (path) => file(path),
    );
    expect(inTreeOrder(files).map(({ path }) => path)).toEqual([
      "src/b/c.ts",
      "src/a.ts",
      "a9",
      "a10",
      "README.md",
    ]);
  });

  it("keeps two files whose names look the same, and names them once", () => {
    const files = [file("�"), file("�", { status: "A" })];
    expect(inTreeOrder(files)).toHaveLength(2);
    expect(distinctPaths(files)).toEqual([files[1]]);
  });

  it("adds up lines, and none of a binary file", () => {
    expect(
      lineTotals([
        file("a", { added: 3, deleted: 0 }),
        file("b", { added: null, deleted: null }),
        file("c", { added: 2, deleted: 7 }),
      ]),
    ).toEqual({ added: 5, deleted: 7 });
  });
});

describe("pathLabel", () => {
  it.each([
    [null, "src/a.ts", "src/a.ts"],
    ["src/X.tsx", "src/replay/X.tsx", "src/{ → replay}/X.tsx"],
    ["src/replay/X.tsx", "src/X.tsx", "src/{replay → }/X.tsx"],
    ["src/a.ts", "src/b.ts", "src/{a.ts → b.ts}"],
    ["a.ts", "b.ts", "a.ts → b.ts"],
    ["a.ts", "src/a.ts", "{ → src}/a.ts"],
    ["a/b/c.ts", "a/d/c.ts", "a/{b → d}/c.ts"],
    ["a/b/c.ts", "x/b/d.ts", "a/b/c.ts → x/b/d.ts"],
    ["a/a/x", "a/a/a/x", "a/a/{ → a}/x"],
  ])("from %s to %s", (from, path, expected) => {
    expect(pathLabel({ from, path })).toBe(expected);
  });
});

describe("statusWord", () => {
  it.each<[Partial<RangeFile>, string | null]>([
    [{}, null],
    [{ status: "A", oldBlob: null }, "Added"],
    [{ status: "D", newBlob: null }, "Deleted"],
    [{ status: "R", from: "b" }, "Renamed"],
    [{ status: "T" }, "Type changed"],
    [{ newBlob: oid("1") }, "Mode changed"],
    [{ submodule: true }, "Submodule"],
    [{ status: "A", submodule: true }, "Added"],
  ])("of %j is %s", (fields, expected) => {
    expect(statusWord(file("a", fields))?.word ?? null).toBe(expected);
  });
});

describe("inPlaceOfLines", () => {
  const text = (patch: string): FilePatch => ({
    kind: "text",
    patch,
    lossy: false,
  });
  const modes = (before: string, after: string) =>
    `diff --git a/a b/a\nold mode ${before}\nnew mode ${after}\n`;
  const lines = "--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old mode 100644\n+b\n";
  it.each<[string, Partial<RangeFile>, FilePatch, string | null]>([
    ["lines", {}, text(lines), null],
    ["a type that changed", { status: "T" }, text(lines), null],
    ["a mode and lines", {}, text(modes("100644", "100755") + lines), null],
    [
      "an executable",
      { newBlob: oid("1") },
      text(modes("100644", "100755")),
      "The file was made executable. Its contents did not change.",
    ],
    [
      "no executable",
      { newBlob: oid("1") },
      text(modes("100755", "100644")),
      "The file is no longer executable. Its contents did not change.",
    ],
    [
      "another mode",
      { newBlob: oid("1") },
      text(modes("100664", "100644")),
      "The file mode changed from 100664 to 100644. Its contents did not change.",
    ],
    [
      "a name",
      { status: "R", from: "b", similarity: 100 },
      text("diff --git a/b b/a\nsimilarity index 100%\nrename from b\n"),
      "Renamed without changes.",
    ],
    [
      "a name and a mode",
      { status: "R", from: "b", similarity: 100 },
      text(`${modes("100644", "100755")}similarity index 100%\n`),
      "Renamed. The file was made executable. Its contents did not change.",
    ],
    [
      "an empty file",
      { status: "A" },
      text("diff --git a/a b/a\nnew file mode 100644\n"),
      "This file was added empty.",
    ],
    [
      "an empty file that went",
      { status: "D" },
      text("diff --git a/a b/a\ndeleted file mode 100644\n"),
      "This file was empty when it was deleted.",
    ],
    [
      "a binary file",
      {},
      { kind: "binary" },
      "Binary file. L1 Git does not display binary changes.",
    ],
    [
      "a large one",
      {},
      { kind: "tooLarge", bytes: 1.5 * 1024 * 1024 },
      "This change is 1.5 MiB, above the 1 MiB display limit.",
    ],
    [
      "a submodule",
      { submodule: true },
      text(lines),
      "This submodule moved from 1111111 to 2222222. L1 Git does not show the changes inside it.",
    ],
    [
      "a new submodule",
      { submodule: true, status: "A", oldBlob: null },
      text(lines),
      "This submodule was added at 2222222.",
    ],
    [
      "a submodule that went",
      { submodule: true, status: "D", newBlob: null },
      text(lines),
      "This submodule was removed. It was at 1111111.",
    ],
    [
      "a submodule's name",
      { submodule: true, status: "R", from: "b", newBlob: oid("1") },
      text("diff --git a/b b/a\nsimilarity index 100%\n"),
      "Renamed without changes.",
    ],
    [
      "a submodule's name and commit",
      { submodule: true, status: "R", from: "b" },
      text(lines),
      "This submodule was renamed, and moved from 1111111 to 2222222.",
    ],
    [
      "a file made a submodule",
      { submodule: true, status: "T" },
      text(lines),
      null,
    ],
  ])("says what changed of %s", (_, fields, patch, expected) => {
    expect(inPlaceOfLines(file("a", fields), patch)).toBe(expected);
  });
});
