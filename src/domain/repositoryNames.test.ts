import { describe, expect, it } from "vitest";
import { rootSchema } from "./repository";
import { distinctNames } from "./repositoryNames";

const entry = (root: string) => ({
  root: rootSchema.parse(root),
  name: root.split(/[\\/]/).at(-1) ?? root,
});

describe("distinct repository names", () => {
  it("adds no suffix when every name is unique", () => {
    const suffixes = distinctNames([
      entry("/work/l1-demo"),
      entry("/work/l1-merge"),
    ]);
    expect(suffixes.size).toBe(0);
  });

  it("names the parent folder of each repository in a pair", () => {
    const suffixes = distinctNames([
      entry("/tmp/l1git-fixture-Awfi7t/l1-demo"),
      entry("/tmp/l1git-fixture-xmjYtf/l1-demo"),
      entry("/tmp/l1git-fixture-xmjYtf/l1-merge"),
    ]);
    expect(Object.fromEntries(suffixes)).toEqual({
      "/tmp/l1git-fixture-Awfi7t/l1-demo": "l1git-fixture-Awfi7t",
      "/tmp/l1git-fixture-xmjYtf/l1-demo": "l1git-fixture-xmjYtf",
    });
  });

  it("walks up until all three of a three-way collision differ", () => {
    const suffixes = distinctNames([
      entry("/a/work/app"),
      entry("/b/work/app"),
      entry("/c/play/app"),
    ]);
    expect(Object.fromEntries(suffixes)).toEqual({
      "/a/work/app": "a/work",
      "/b/work/app": "b/work",
      "/c/play/app": "c/play",
    });
  });

  it("shows the whole parent path when one repository sits higher up", () => {
    const suffixes = distinctNames([
      entry("/work/app"),
      entry("/home/work/app"),
    ]);
    expect(Object.fromEntries(suffixes)).toEqual({
      "/work/app": "/work",
      "/home/work/app": "home/work",
    });
  });

  it("keeps Windows separators", () => {
    const suffixes = distinctNames([
      entry("C:\\Users\\ada\\src\\app"),
      entry("C:\\Users\\ada\\old\\src\\app"),
    ]);
    expect(Object.fromEntries(suffixes)).toEqual({
      "C:\\Users\\ada\\src\\app": "ada\\src",
      "C:\\Users\\ada\\old\\src\\app": "old\\src",
    });
  });
});
