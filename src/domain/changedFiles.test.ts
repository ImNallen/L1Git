import { describe, expect, it } from "vitest";
import {
  changedFileTreeInput,
  changedPathAt,
  firstChangedPath,
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
