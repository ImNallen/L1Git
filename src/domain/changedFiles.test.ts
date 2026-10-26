import { describe, expect, it } from "vitest";
import {
  changedFileTreeInput,
  changedPathAt,
  firstChangedPath,
  nearbyRows,
  pathsUnder,
} from "./changedFiles";

describe("changed file tree input", () => {
  it("draws an untracked nested repository as a leaf, not an empty folder", () => {
    const files = [{ path: "nested/" }, { path: "src/a.ts" }];
    expect(changedFileTreeInput(files).paths).toContain("nested");
    expect(changedFileTreeInput(files).paths).not.toContain("nested/");
    expect(changedPathAt(files, "nested")).toBe("nested/");
    expect(changedPathAt(files, "src/a.ts")).toBe("src/a.ts");
    expect(changedPathAt(files, "src/")).toBeUndefined();
    expect(firstChangedPath([{ path: "nested/" }])).toBe("nested/");
  });
});

describe("paths under a tree row", () => {
  const files = [
    { path: "src/ui/a.ts" },
    { path: "src/ui/b.ts" },
    { path: "src-old.ts" },
    { path: "nested/" },
  ];

  it("lists a file row's own path and every listed path in a folder", () => {
    expect(pathsUnder(files, { kind: "file", path: "nested" })).toEqual([
      "nested/",
    ]);
    expect(pathsUnder(files, { kind: "directory", path: "src" })).toEqual([
      "src/ui/a.ts",
      "src/ui/b.ts",
    ]);
    expect(pathsUnder(files, { kind: "directory", path: "src/ui/" })).toEqual([
      "src/ui/a.ts",
      "src/ui/b.ts",
    ]);
  });
});

describe("rows beside a removed row", () => {
  const files = [
    { path: "a.ts" },
    { path: "src/ui/b.ts" },
    { path: "src/ui/c.ts" },
    { path: "d.ts" },
    { path: "e.ts" },
  ];

  it("puts the rows after it first, nearest first, then the rows before it", () => {
    expect(nearbyRows(files, "d.ts")).toEqual([
      "e.ts",
      "a.ts",
      "src/ui/c.ts",
      "src/ui/b.ts",
    ]);
    expect(nearbyRows(files, "e.ts")).toEqual([
      "d.ts",
      "a.ts",
      "src/ui/c.ts",
      "src/ui/b.ts",
    ]);
  });

  it("skips every row inside a folder row", () => {
    expect(nearbyRows(files, "src/ui/")).toEqual(["a.ts", "d.ts", "e.ts"]);
  });

  it("finds no row for a path the list does not show", () => {
    expect(nearbyRows(files, "gone.ts")).toEqual([]);
    expect(nearbyRows([{ path: "a.ts" }], "a.ts")).toEqual([]);
  });
});
