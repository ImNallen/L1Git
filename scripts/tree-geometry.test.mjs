import assert from "node:assert/strict";
import { test } from "node:test";
import { FileTree, preloadFileTree } from "@pierre/trees";

const dist = new URL("./", import.meta.resolve("@pierre/trees"));
const { FileTreeController } = await import(
  new URL("model/FileTreeController.js", dist)
);
const { PathStore } = await import(new URL("path-store/src/store.js", dist));
const { computeFileTreeLayout, computeStickyRows } = await import(
  new URL("model/layout.js", dist)
);
const { computeFocusedRowScrollTopForOffset } = await import(
  new URL("render/scrollTarget.js", dist)
);
const paths = Array.from(
  { length: 4000 },
  (_, i) =>
    `dir-${String(Math.floor(i / 20)).padStart(3, "0")}/file-${String(i).padStart(4, "0")}.ts`,
);
function verifyRows(controller) {
  const rows = controller.getVisibleRows(0, controller.getVisibleCount() - 1);
  const geometry = controller.getRowGeometry(32, 34);
  let top = 0;
  rows.forEach((row, index) => {
    const height = row.kind === "directory" ? 32 : 34;
    assert.equal(geometry.top(index), top);
    assert.equal(geometry.height(index), height);
    assert.equal(geometry.firstIntersecting(top), index);
    assert.equal(geometry.firstIntersecting(top + height - 0.5), index);
    assert.equal(geometry.lastIntersecting(top + height), index);
    assert.equal(geometry.lastIntersecting(top), index - 1);
    top += height;
  });
  assert.equal(geometry.top(rows.length), top);
  assert.equal(geometry.firstIntersecting(top), rows.length || -1);
  return { rows, geometry, total: top };
}

test("mixed geometry, exact boundaries and bounded middle/end windows", () => {
  const model = new FileTreeController({ paths, initialExpansion: "open" });
  const { geometry, total } = verifyRows(model);
  assert.equal(total, 4000 * 34 + 200 * 32);
  for (const scrollTop of [0, total / 2, total, total + 1000]) {
    const layout = computeFileTreeLayout([], {
      itemHeight: 32,
      rowGeometry: geometry,
      totalRowCount: model.getVisibleCount(),
      viewportHeight: 306,
      overscan: 3,
      stickyRows: [],
      scrollTop,
    });
    assert.equal(layout.physical.totalHeight, total);
    assert.ok(layout.window.endIndex - layout.window.startIndex < 17);
    assert.equal(
      layout.window.offsetTop,
      geometry.top(layout.window.startIndex),
    );
    assert.equal(
      layout.window.height,
      geometry.top(layout.window.endIndex + 1) - layout.window.offsetTop,
    );
    assert.ok(
      geometry.top(layout.visible.startIndex) <= layout.physical.scrollTop,
    );
    assert.ok(
      geometry.top(layout.visible.endIndex + 1) >=
        layout.physical.scrollTop + 306,
    );
  }
  model.destroy();
});

test("directory cache stays lazy and is reused across focus, selection and scroll", () => {
  const originalIndex = PathStore.prototype.getVisibleIndex;
  let lookups = 0;
  PathStore.prototype.getVisibleIndex = function (...args) {
    lookups++;
    return originalIndex.apply(this, args);
  };
  const model = new FileTreeController({ paths, initialExpansion: "open" });
  const originalRows = model.getVisibleRows;
  model.getVisibleRows = () => {
    throw new Error("geometry projected row objects");
  };
  try {
    const geometry = model.getRowGeometry(32, 34);
    assert.ok(lookups >= 200);
    const afterBuild = lookups;
    for (let i = 0; i < 30; i++) {
      geometry.firstIntersecting(i * 2100);
      assert.equal(model.getRowGeometry(32, 34), geometry);
    }
    assert.equal(lookups, afterBuild);
    for (let i = 0; i < 550; i++) model.focusNextItem();
    model.selectPath(paths[550]);
    model.scrollToPath(paths[2500], { offset: "center" });
    const afterOperations = lookups;
    assert.equal(model.getRowGeometry(32, 34), geometry);
    assert.equal(lookups, afterOperations);
  } finally {
    model.getVisibleRows = originalRows;
    model.destroy();
    PathStore.prototype.getVisibleIndex = originalIndex;
  }
});

test("collapse, expand, reset and same-count search invalidate geometry", () => {
  const model = new FileTreeController({
    paths: ["a/x.ts", "a/y.ts", "b/x.ts", "root.ts"],
    initialExpansion: "open",
  });
  const initial = model.getRowGeometry(32, 34);
  model.getItem("a/").collapse();
  assert.notEqual(model.getRowGeometry(32, 34), initial);
  verifyRows(model);
  model.getItem("a/").expand();
  verifyRows(model);
  model.setSearch("x.ts");
  const search = model.getRowGeometry(32, 34);
  const searchCount = model.getVisibleCount();
  verifyRows(model);
  model.setSearch("a");
  verifyRows(model);
  model.setSearch(null);
  model.resetPaths(["a/x.ts", "a/y.ts", "b/x.ts", "root.ts"]);
  verifyRows(model);
  assert.notEqual(model.getRowGeometry(32, 34), search);
  model.resetPaths(["x/a.ts", "y/a.ts"]);
  model.setSearch("a.ts");
  assert.equal(model.getVisibleCount(), searchCount);
  verifyRows(model);
  model.setSearch("x");
  const first = model.getRowGeometry(32, 34);
  const count = model.getVisibleCount();
  model.setSearch("y");
  assert.equal(model.getVisibleCount(), count);
  assert.notEqual(model.getRowGeometry(32, 34), first);
  verifyRows(model);
  model.destroy();
});

test("flattened and explicit directories contribute only mounted rows", () => {
  for (const flattenEmptyDirectories of [true, false]) {
    const model = new FileTreeController({
      paths: ["a/b/c/file.ts", "empty/", "root.ts"],
      initialExpansion: "open",
      flattenEmptyDirectories,
    });
    const { rows, total } = verifyRows(model);
    assert.equal(
      total,
      rows.filter((r) => r.kind === "directory").length * 32 + 68,
    );
    model.setSearch("file");
    verifyRows(model);
    model.setSearch(null);
    verifyRows(model);
    model.destroy();
  }
});

test("sticky candidate boundaries and filtered fallback share mixed geometry", () => {
  const model = new FileTreeController({ paths, initialExpansion: "open" });
  for (const query of [null, "file-0"]) {
    model.setSearch(query);
    const { rows, geometry } = verifyRows(model);
    for (const offset of [1, 680, 700, 712, 725, 1410]) {
      const fallback = computeStickyRows(rows, offset, 32, geometry);
      for (const { row, top } of fallback) {
        const end = rows.findIndex(
          (other) =>
            other.index > row.index && !other.ancestorPaths.includes(row.path),
        );
        assert.equal(
          top,
          end < 0 ? 0 : Math.min(0, geometry.top(end) - offset - 32),
        );
      }
      const candidates = model.getStickyRowCandidates(offset, 32, geometry);
      if (candidates)
        assert.deepEqual(
          candidates.map((c) => c.row.path),
          fallback.map((c) => c.row.path),
        );
    }
  }
  model.destroy();
});

test("uniform defaults and empty trees retain their geometry", () => {
  const model = new FileTreeController({ paths, initialExpansion: "open" });
  const geometry = model.getRowGeometry(27);
  assert.equal(geometry.top(model.getVisibleCount()), 4200 * 27);
  for (const i of [0, 2001, 4199]) {
    assert.equal(geometry.top(i), i * 27);
    assert.equal(geometry.height(i), 27);
    assert.equal(geometry.firstIntersecting(i * 27), i);
    assert.equal(geometry.lastIntersecting((i + 1) * 27), i);
  }
  model.resetPaths([]);
  const empty = model.getRowGeometry(32, 34);
  assert.equal(empty.top(0), 0);
  assert.equal(empty.firstIntersecting(0), -1);
  assert.equal(empty.lastIntersecting(1), -1);
  model.destroy();
});

test("scroll alignment uses row top and actual height; SSR forwards file height", () => {
  const model = new FileTreeController({ paths, initialExpansion: "open" });
  const rowGeometry = model.getRowGeometry(32, 34);
  for (const focusedIndex of [2100, 2101]) {
    const top = rowGeometry.top(focusedIndex);
    const height = rowGeometry.height(focusedIndex);
    const input = {
      rowGeometry,
      focusedIndex,
      currentScrollTop: 0,
      viewportHeight: 300,
      totalHeight: rowGeometry.top(4200),
    };
    assert.equal(
      computeFocusedRowScrollTopForOffset({ ...input, offset: "top" }),
      top,
    );
    assert.equal(
      computeFocusedRowScrollTopForOffset({ ...input, offset: "center" }),
      top - (300 - height) / 2,
    );
    assert.equal(
      computeFocusedRowScrollTopForOffset({ ...input, offset: "nearest" }),
      top + height - 300,
    );
  }
  const { shadowHtml } = preloadFileTree({
    paths: ["src/a.ts"],
    initialExpansion: "open",
    itemHeight: 32,
    fileItemHeight: 34,
  });
  assert.match(shadowHtml, /min-height:32px;--trees-row-height:32px/);
  assert.match(shadowHtml, /min-height:34px;--trees-row-height:34px/);
  const publicModel = new FileTree({
    paths: ["a.ts"],
    itemHeight: 32,
    fileItemHeight: 34,
  });
  assert.equal(publicModel.getItemHeight(), 32);
  publicModel.cleanUp();
  model.destroy();
});

test("SSR initial row count uses the mixed height of those rows", () => {
  const { shadowHtml } = preloadFileTree({
    paths: Array.from({ length: 100 }, (_, i) => `file-${i}.ts`),
    itemHeight: 32,
    fileItemHeight: 34,
    initialVisibleRowCount: 20,
    overscan: 0,
  });
  assert.equal([...shadowHtml.matchAll(/role="treeitem"/g)].length, 20);
});

test("same-count reorder changes directory positions", () => {
  const model = new FileTreeController({
    paths: ["a/x.ts", "b/x.ts", "b/y.ts"],
    initialExpansion: "open",
  });
  const before = verifyRows(model).geometry;
  const count = model.getVisibleCount();
  model.resetPaths(["a/x.ts", "a/y.ts", "b/x.ts"]);
  assert.equal(model.getVisibleCount(), count);
  const after = verifyRows(model).geometry;
  assert.notEqual(before, after);
  assert.equal(before.height(2), 32);
  assert.equal(after.height(2), 34);
  model.destroy();
});
