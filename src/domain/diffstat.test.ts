import { describe, expect, it } from "vitest";
import { diffstatBlocks } from "./diffstat";

describe("diffstatBlocks", () => {
  it("splits five blocks by the share of added and deleted lines", () => {
    expect(diffstatBlocks(898, 185)).toEqual([
      "added",
      "added",
      "added",
      "added",
      "deleted",
    ]);
    expect(diffstatBlocks(3, 2)).toEqual([
      "added",
      "added",
      "added",
      "deleted",
      "deleted",
    ]);
    expect(diffstatBlocks(0, 40)).toEqual([
      "deleted",
      "deleted",
      "deleted",
      "deleted",
      "deleted",
    ]);
  });

  it("colors one block per changed line when fewer than five changed", () => {
    expect(diffstatBlocks(1, 0)).toEqual([
      "added",
      "neutral",
      "neutral",
      "neutral",
      "neutral",
    ]);
    expect(diffstatBlocks(1, 2)).toEqual([
      "added",
      "deleted",
      "deleted",
      "neutral",
      "neutral",
    ]);
  });

  it("leaves every block neutral for a commit without line changes", () => {
    expect(diffstatBlocks(0, 0)).toEqual([
      "neutral",
      "neutral",
      "neutral",
      "neutral",
      "neutral",
    ]);
  });
});
