import { FileTree } from "@pierre/trees";
import "../src/styles/inspector.css";
import { createRoot } from "react-dom/client";
import { ChangedFileTree } from "../src/components/ChangedFileTree";

const container = document.querySelector<HTMLDivElement>("#tree")!;
const report = document.querySelector<HTMLPreElement>("#report")!;
const results: string[] = [];
const paths = Array.from(
  { length: 4000 },
  (_, i) =>
    `dir-${String(Math.floor(i / 20)).padStart(3, "0")}/file-${String(i).padStart(4, "0")}.ts`,
);
const settle = async () => {
  for (let i = 0; i < 4; i++)
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
};
function check(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}
function near(actual: number, expected: number, message: string) {
  check(
    Math.abs(actual - expected) < 0.1,
    `${message}: ${actual} != ${expected}`,
  );
}
function treeRoot(model: FileTree) {
  return model.getFileTreeContainer()!.shadowRoot!;
}
function scroller(model: FileTree) {
  return treeRoot(model).querySelector<HTMLElement>(
    "[data-file-tree-virtualized-scroll]",
  )!;
}
function normalRows(model: FileTree) {
  return [
    ...treeRoot(model).querySelectorAll<HTMLElement>(
      '[role="treeitem"]:not([data-item-parked])',
    ),
  ];
}
function expectedRows(model: FileTree, fileHeight = 34) {
  let top = 0;
  return model.getVisibleRows(0, model.getVisibleCount() - 1).map((row) => {
    const height = row.kind === "directory" ? 32 : fileHeight;
    const result = { ...row, top, height };
    top += height;
    return result;
  });
}
function verifyWindow(model: FileTree, fileHeight = 34) {
  const expected = expectedRows(model, fileHeight);
  const scroll = scroller(model);
  check(scroll !== null, "scroll container exists");
  const total = expected.reduce((sum, row) => sum + row.height, 0);
  const list = treeRoot(model).querySelector<HTMLElement>(
    "[data-file-tree-virtualized-list]",
  )!;
  const mounted = normalRows(model);
  check(mounted.length < 50, `bounded window (${mounted.length})`);
  for (const element of mounted) {
    const row = expected.find((r) => r.path === element.dataset.itemPath)!;
    check(row !== undefined, "mounted path in visible projection");
    near(
      element.getBoundingClientRect().height,
      row.height,
      `height ${row.path}`,
    );
    near(
      element.getBoundingClientRect().top - list.getBoundingClientRect().top,
      row.top,
      `top ${row.path}`,
    );
    near(
      Number.parseFloat(
        getComputedStyle(element).getPropertyValue("--trees-row-height"),
      ),
      row.height,
      "local CSS height",
    );
  }
  near(Number.parseFloat(list.style.height), total, "total physical height");
  return expected;
}
async function press(model: FileTree, key: string, count = 1) {
  const root = treeRoot(model);
  for (let i = 0; i < count; i++) {
    const target = root.querySelector<HTMLElement>(
      '[role="treeitem"][tabindex="0"]',
    )!;
    check(target !== null, `focused row mounted before ${key}`);
    target.focus({ preventScroll: true });
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, composed: true }),
    );
    await settle();
  }
}
function visibleFocus(model: FileTree) {
  const row = treeRoot(model).querySelector<HTMLElement>(
    '[role="treeitem"][tabindex="0"]',
  )!;
  check(
    row !== null && !row.hasAttribute("data-item-parked"),
    "focus is a rendered row",
  );
  const rect = row.getBoundingClientRect();
  const viewport = scroller(model).getBoundingClientRect();
  check(
    rect.top >= viewport.top - 0.1 && rect.bottom <= viewport.bottom + 0.1,
    `focused row visible (${rect.top}, ${rect.bottom}) in (${viewport.top}, ${viewport.bottom})`,
  );
}
async function mount(
  options: Partial<ConstructorParameters<typeof FileTree>[0]> = {},
) {
  const model = new FileTree({
    paths,
    initialExpansion: "open",
    itemHeight: 32,
    fileItemHeight: 34,
    overscan: 3,
    ...options,
  });
  model.render({ containerWrapper: container });
  await settle();
  return model;
}
async function run() {
  let model = await mount({ initialSelectedPaths: [paths[2500]!] });
  verifyWindow(model);
  visibleFocus(model);
  results.push("initial selection at file 2500 scrolls into view");
  await press(model, "Home");
  near(scroller(model).scrollTop, 0, "Home scroll");
  verifyWindow(model);
  await press(model, "ArrowDown", 80);
  visibleFocus(model);
  verifyWindow(model);
  await press(model, "End");
  visibleFocus(model);
  verifyWindow(model);
  results.push(
    "Home, 80 ArrowDown presses and End preserve focus and exact rows",
  );
  for (const offset of ["top", "center", "nearest"] as const) {
    model.scrollToPath(paths[2000]!, { offset });
    await settle();
    const row = expectedRows(model).find((r) => r.path === paths[2000])!;
    const scroll = scroller(model);
    const expected =
      offset === "top"
        ? row.top
        : offset === "center"
          ? row.top - (scroll.getBoundingClientRect().height - row.height) / 2
          : scroll.scrollTop;
    near(scroll.scrollTop, expected, `scrollToPath ${offset}`);
    visibleFocus(model);
    verifyWindow(model);
  }
  model.scrollToPath(paths[3000]!, { offset: "nearest" });
  await settle();
  visibleFocus(model);
  verifyWindow(model);
  results.push("scrollToPath top, center and nearest use mixed row positions");
  const directory = model.getItem("dir-000/");
  check(directory?.isDirectory() === true, "directory handle exists");
  if (directory && "collapse" in directory) {
    directory.collapse();
    await settle();
    verifyWindow(model);
    directory.expand();
    await settle();
    verifyWindow(model);
  }
  for (const query of ["file-100", "file-200", null]) {
    model.setSearch(query);
    await settle();
    verifyWindow(model);
  }
  results.push(
    "collapse/expand above viewport and same-count search/clear update geometry",
  );
  model.scrollToPath(paths[3999]!, { offset: "nearest" });
  await settle();
  container.style.height = "612px";
  await settle();
  verifyWindow(model);
  visibleFocus(model);
  results.push("viewport resize clamps the end window");
  container.style.height = "306px";
  model.cleanUp();
  model = await mount({
    paths: ["deep/a/b/file.ts", "empty/", "root.ts"],
    flattenEmptyDirectories: true,
  });
  verifyWindow(model);
  model.setSearch("file");
  await settle();
  verifyWindow(model);
  model.setSearch(null);
  await settle();
  verifyWindow(model);
  model.cleanUp();
  results.push(
    "flattened directory rows and explicit empty directories retain geometry",
  );
  model = await mount({ fileItemHeight: undefined });
  verifyWindow(model, 32);
  await press(model, "End");
  verifyWindow(model, 32);
  model.cleanUp();
  results.push("uniform callers retain 32px rows and scrolling");
  model = await mount({ stickyFolders: true });
  for (const scrollTop of [680, 700, 712, 725, 1400, 68000]) {
    scroller(model).scrollTop = scrollTop;
    scroller(model).dispatchEvent(new Event("scroll"));
    await settle();
    verifyWindow(model);
    for (const row of treeRoot(model).querySelectorAll<HTMLElement>(
      "[data-file-tree-sticky-row]",
    ))
      near(row.getBoundingClientRect().height, 32, "sticky directory height");
  }
  model.setSearch("file-0");
  await settle();
  scroller(model).scrollTop = 700;
  scroller(model).dispatchEvent(new Event("scroll"));
  await settle();
  verifyWindow(model);
  model.setSearch(null);
  await settle();
  model.scrollToPath(paths[3000]!, { offset: "center" });
  await settle();
  await press(model, "End");
  verifyWindow(model);
  visibleFocus(model);
  results.push(
    "sticky folders support mixed subtree boundaries, filtered search and End",
  );
  model.cleanUp();
  model = await mount({
    paths: paths.map((path) => `root/${path}`),
    stickyFolders: true,
  });
  for (const offset of ["top", "center", "nearest"] as const) {
    model.scrollToPath(`root/${paths[2200]}`, { offset });
    await settle();
    verifyWindow(model);
    visibleFocus(model);
    const sticky = [
      ...treeRoot(model).querySelectorAll<HTMLElement>(
        "[data-file-tree-sticky-row]",
      ),
    ];
    check(sticky.length === 2, "nested sticky ancestors remain mounted");
    for (const row of sticky)
      near(row.getBoundingClientRect().height, 32, "nested sticky height");
  }
  await press(model, "Home");
  await press(model, "ArrowDown", 25);
  verifyWindow(model);
  visibleFocus(model);
  results.push(
    "nested sticky folders support scroll alignment and keyboard navigation",
  );
  model.cleanUp();
  model = await mount({ search: true, searchBlurBehavior: "retain" });
  model.scrollToPath(paths[1500]!, { offset: "center" });
  await settle();
  const focus = treeRoot(model).querySelector<HTMLElement>('[tabindex="0"]')!;
  focus.focus({ preventScroll: true });
  scroller(model).scrollTop += 3000;
  scroller(model).dispatchEvent(new Event("scroll"));
  await settle();
  const parked = treeRoot(model).querySelector<HTMLElement>(
    '[data-item-parked="true"]',
  )!;
  check(parked !== null, "offscreen focused row stays parked");
  near(parked.getBoundingClientRect().height, 34, "parked file height");
  await press(model, "ArrowDown");
  visibleFocus(model);
  verifyWindow(model);
  results.push("parked focused file returns to the viewport on ArrowDown");
  model.openSearch();
  await settle();
  const input = treeRoot(model).querySelector<HTMLInputElement>(
    "[data-file-tree-search-input]",
  )!;
  input.focus();
  input.value = "file-250";
  input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  await settle();
  verifyWindow(model);
  input.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      composed: true,
    }),
  );
  await settle();
  check(!model.isSearchOpen(), "Enter closes built-in search");
  visibleFocus(model);
  verifyWindow(model);
  results.push(
    "parked focus survives scrolling and built-in search restores visible focus on Enter",
  );
  model.cleanUp();
  const app = document.querySelector<HTMLDivElement>("#app")!;
  const publicGetRows = FileTree.prototype.getVisibleRows;
  const fittedRequests: number[] = [];
  FileTree.prototype.getVisibleRows = function (start, end) {
    fittedRequests.push(end - start + 1);
    return publicGetRows.call(this, start, end);
  };
  createRoot(app).render(
    <ChangedFileTree
      files={paths.map((path) => ({ path, status: "modified" }))}
      selectedPath={null}
      onSelectFile={() => {}}
      maxRows={5}
    />,
  );
  await settle();
  const fit = app.querySelector<HTMLElement>(".fitted-file-tree")!;
  near(
    fit.getBoundingClientRect().height,
    32 + 4 * 34 + 8,
    "fitted first five rows",
  );
  const appRoot = app.querySelector("file-tree-container")!.shadowRoot!;
  const folder = appRoot.querySelector<HTMLElement>(
    '[data-item-type="folder"]',
  )!;
  folder.click();
  await settle();
  near(
    fit.getBoundingClientRect().height,
    2 * 32 + 3 * 34 + 8,
    "fitted first five after collapse",
  );
  const appRows = [
    ...appRoot.querySelectorAll<HTMLElement>('[role="treeitem"]'),
  ];
  for (const row of appRows)
    near(
      row.getBoundingClientRect().height,
      row.dataset.itemType === "folder" ? 32 : 34,
      "application row height",
    );
  FileTree.prototype.getVisibleRows = publicGetRows;
  check(
    fittedRequests.length > 0 && fittedRequests.every((count) => count <= 5),
    "fitted height projects at most maxRows",
  );
  results.push(
    "ChangedFileTree uses 32/34px rows and bounded fitted maxRows after collapse",
  );
}
run()
  .then(() => {
    report.textContent = JSON.stringify(
      { passed: true, checks: results },
      null,
      2,
    );
    report.dataset.result = "passed";
  })
  .catch((error: unknown) => {
    report.textContent = JSON.stringify(
      {
        passed: false,
        checks: results,
        error: error instanceof Error ? error.stack : String(error),
      },
      null,
      2,
    );
    report.dataset.result = "failed";
  });
