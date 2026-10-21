import { describe, expect, it } from "vitest";
import {
  changedFileTreeInput,
  changedPathAt,
  firstChangedPath,
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
