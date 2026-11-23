import { preloadFileTree } from "@pierre/trees/ssr";
import { describe, expect, it } from "vitest";
import { focusedRow, rowItems } from "./ChangedFileTree";

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

describe("a row's menu items", () => {
  const run = () => {};
  const open = { label: "Open in resolver", disabled: false, run };
  const mark = {
    label: "Mark resolved",
    disabled: false,
    run,
    appliesTo: new Set(["ready.txt"]),
    blockedBy: new Map([["conflict.txt", "Resolve every conflict first."]]),
  };
  const items = (under: string[], actions = [open, mark]) =>
    rowItems(actions, under).map(({ action, paths, blocked }) => [
      action.label,
      paths,
      blocked,
    ]);

  it("keeps a blocked action, disabled with its reason, so the menu is never empty", () => {
    expect(items(["conflict.txt"])).toEqual([
      ["Open in resolver", ["conflict.txt"], null],
      ["Mark resolved", [], "Resolve every conflict first."],
    ]);
  });

  it("runs a folder's action on the paths it applies to and drops one with no reason", () => {
    expect(items(["conflict.txt", "ready.txt"], [mark])).toEqual([
      ["Mark resolved", ["ready.txt"], null],
    ]);
    expect(items(["other.txt"], [mark])).toEqual([]);
  });
});
