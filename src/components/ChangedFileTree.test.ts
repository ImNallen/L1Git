import { readFileSync } from "node:fs";
import { preloadFileTree } from "@pierre/trees/ssr";
import { describe, expect, it } from "vitest";
import { focusedRow, keyboardFocusOnly } from "./ChangedFileTree";

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

describe("the row a write hands focus back to", () => {
  it("is the focused row, found by the selector the tree still renders", () => {
    const { shadowHtml } = preloadFileTree({
      paths: ["README.md", "src/a.ts", "src/b.ts"],
      initialSelectedPaths: ["src/b.ts"],
      initialExpansion: "open",
    });
    const wanted = [...focusedRow.matchAll(/\[([\w-]+)="([^"]*)"\]/g)];
    const rows = [...shadowHtml.matchAll(/<[a-z][^>]*>/g)]
      .map(
        ([tag]) =>
          new Map(
            [...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, name, value]) => [
              name,
              value,
            ]),
          ),
      )
      .filter((attributes) =>
        wanted.every(([, name, value]) => attributes.get(name!) === value),
      );
    expect(wanted).not.toEqual([]);
    expect(rows.map((attributes) => attributes.get("data-item-path"))).toEqual([
      "src/b.ts",
    ]);
  });
});
