import { preloadFileTree } from "@pierre/trees/ssr";
import { describe, expect, it } from "vitest";
import { focusedRow } from "./ChangedFileTree";

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
