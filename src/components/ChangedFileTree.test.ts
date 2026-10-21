import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { keyboardFocusOnly } from "./ChangedFileTree";

describe("the tree's keyboard focus cue", () => {
  it("targets row attributes that @pierre/trees still renders", () => {
    const style = readFileSync(
      new URL("style.js", import.meta.resolve("@pierre/trees")),
      "utf8",
    ).replaceAll('\\"', '"');
    const attributes = new Set(keyboardFocusOnly.match(/\[[^\]]+\]/g));
    expect([...attributes]).toEqual([
      '[data-type="item"]',
      '[data-item-selected="true"]',
    ]);
    for (const attribute of attributes) expect(style).toContain(attribute);
  });
});
