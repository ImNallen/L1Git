// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
import { CodeView } from "@pierre/diffs";
import type { PullRequest, ReviewThread } from "./domain/pullRequest";
import type { RangeFile } from "./domain/range";
import { oidSchema } from "./domain/repository";
import { focused, get, installHarness, queryAll } from "./test/appHarness";
import type { Harness } from "./test/appHarness";
import { pullKey } from "./test/fakeBridge";
import type { Bridge } from "./test/fakeBridge";
import { at, open, page, pull, refresh, tab, visit } from "./test/pullRequests";

installHarness();

/** What Pierre reads of the layout, of which there is none here. */
beforeEach(() => {
  const height = (element: HTMLElement) =>
    element.dataset.line !== undefined
      ? 22
      : element.classList.contains("files-all-scroll")
        ? 900
        : 0;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return new DOMRect(0, 0, 800, height(this));
    },
  );
});

const oid = (digit: string) => oidSchema.parse(digit.repeat(40));
const file = (path: string, fields: Partial<RangeFile> = {}): RangeFile => ({
  path,
  status: "M",
  from: null,
  similarity: null,
  added: 2,
  deleted: 1,
  oldBlob: oid("1"),
  newBlob: oid("2"),
  oldMode: "100644",
  newMode: "100644",
  submodule: false,
  ...fields,
});
const patchOf = (path: string, from = path) =>
  `diff --git a/${from} b/${path}\n--- a/${from}\n+++ b/${path}\n@@ -10,3 +10,4 @@\n one\n-two\n+TWO\n+and\n three\n`;
/** Longer than the view, with a change at line 60. */
const longPatch = (path: string, from = path) =>
  `--- a/${from}\n+++ b/${path}\n@@ -1,99 +1,100 @@\n${" line\n".repeat(59)}+new\n${" line\n".repeat(40)}`;
const files = [
  file("src/a.ts"),
  file("src/new.ts", { status: "R", from: "src/old.ts", similarity: 94 }),
  file("src/z.png", { added: null, deleted: null }),
];
const patches = () =>
  files.map(({ path, from }) => ({
    path,
    patch:
      path === "src/z.png"
        ? { kind: "binary" }
        : { kind: "text", patch: patchOf(path, from ?? path), lossy: false },
  }));
const thread = (
  id: string,
  fields: Partial<ReviewThread> = {},
): ReviewThread => ({
  id,
  review: null,
  path: "src/a.ts",
  line: 11,
  startLine: null,
  originalLine: 11,
  originalStartLine: null,
  side: "right",
  outdated: false,
  resolved: false,
  hunk: "",
  can: { reply: true, resolve: true, unresolve: false },
  comments: page([
    { id: `${id}-1`, by: "sara", at: at(2), body: `Says ${id}` },
  ]),
  ...fields,
});
const counts = { changedFiles: 3, additions: 4, deletions: 2 };

async function openAll(
  fields: Partial<PullRequest> = {},
  more: (bridge: Bridge) => void = () => {},
): Promise<Harness> {
  const app = await visit({
    stored: {
      "l1git.filesChanged.v1":
        '{"version":1,"diffStyle":"unified","view":"all"}',
    },
    world: (world) => {
      const shown = pull(1, { ...counts, ...fields });
      world.host.details.set(pullKey("octo/pin", 1), shown);
    },
    bridge: (bridge) => {
      bridge.respond("rangeFiles", () => ({
        kind: "ready",
        mergeBase: oid("a"),
        files,
        contentMissing: false,
        shallow: false,
      }));
      bridge.respond("rangePatches", patches);
      more(bridge);
    },
  });
  await open(app, 1);
  await app.click(tab("Files changed"));
  await frames(app);
  return app;
}
async function frames(app: Harness) {
  for (let frame = 0; frame < 5; frame += 1) await app.flushFrames();
}
const panel = () => get("tabpanel", /^Files changed/);
const headers = () =>
  [...panel().querySelectorAll(".files-header")].map(
    ({ textContent }) => textContent,
  );
const selected = () =>
  get("complementary", "Pull request details")
    .querySelector("file-tree-container")
    ?.shadowRoot?.querySelector("[aria-selected=true]")
    ?.getAttribute("data-item-path");
const fold = (path: string | RegExp) => get("button", path, panel());

it("shows each file after the other, and keeps the choice", async () => {
  const app = await openAll();
  expect(headers()).toEqual([
    "src/a.ts+2−1Viewed",
    "src/{old.ts → new.ts}Renamed+2−1Viewed",
    "src/z.pngViewed",
  ]);
  expect(panel().querySelector(".files-toolbar")?.textContent).toMatch(
    /^3 files\+4−2/,
  );
  expect(panel().textContent).toContain(
    "Moved from src/old.ts · 94% the same.",
  );
  expect(panel().textContent).toContain("Binary file.");
  expect(get("button", "All files", panel()).getAttribute("aria-pressed")).toBe(
    "true",
  );
  await app.click(get("button", "One file", panel()));
  expect(panel().querySelector(".files-header")).toBeNull();
  expect(localStorage.getItem("l1git.filesChanged.v1")).toBe(
    '{"version":1,"diffStyle":"unified","view":"one"}',
  );
});

it("has the same current file in both views", async () => {
  const app = await openAll();
  expect(selected()).toBe("src/a.ts");
  await app.press("j");
  await frames(app);
  expect(selected()).toBe("src/new.ts");
  await app.click(get("button", "One file", panel()));
  expect(document.querySelector(".files-position")?.textContent).toBe("2 of 3");
  await app.press("j");
  await app.click(get("button", "All files", panel()));
  await frames(app);
  expect(selected()).toBe("src/z.png");
  await app.press("k");
  expect(selected()).toBe("src/new.ts");
});

it("goes through the changes of one file after the other", async () => {
  const app = await openAll();
  await app.press("n");
  await app.press("n");
  expect(selected()).toBe("src/new.ts");
  await app.press("n");
  expect(selected(), "there is no change after it").toBe("src/new.ts");
  await app.press("p");
  expect(selected()).toBe("src/a.ts");
});

it("folds a file, and skips its changes", async () => {
  const app = await openAll();
  const chevron = fold("src/a.ts");
  expect(chevron.getAttribute("aria-expanded")).toBe("true");
  await app.click(chevron);
  await frames(app);
  expect(fold("src/a.ts").getAttribute("aria-expanded")).toBe("false");
  expect(
    queryAll("button", /^src/, panel()).map((each) =>
      each.getAttribute("aria-expanded"),
    ),
  ).toEqual(["false", "true", "true"]);
  await app.press("n");
  expect(selected()).toBe("src/new.ts");
  await app.click(get("button", "One file", panel()));
  await app.click(get("button", "All files", panel()));
  await frames(app);
  expect(fold("src/a.ts").getAttribute("aria-expanded")).toBe("false");
});

it("folds a file without lines, and unfolds it", async () => {
  const app = await openAll();
  const chevron = fold("src/z.png");
  for (const expanded of ["false", "true", "false"]) {
    await app.click(chevron);
    await frames(app);
    expect(fold("src/z.png").getAttribute("aria-expanded")).toBe(expanded);
  }
});

it("shows a message when Pierre fails, and draws them when asked", async () => {
  const app = await openAll();
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const items = vi.spyOn(CodeView.prototype, "setItems");
  try {
    items.mockImplementation(() => {
      throw new Error("a different file");
    });
    await app.click(fold("src/a.ts"));
    expect(panel().textContent).toContain("Couldn't show the changes");
    expect(get("link", "Open on GitHub", panel()).getAttribute("href")).toBe(
      "https://github.com/octo/pin/pull/1/files",
    );
    items.mockRestore();
    await app.click(get("button", "Try again", panel()));
    await frames(app);
    expect(headers()).toHaveLength(3);
    items.mockImplementation(() => {
      throw new Error("a different file");
    });
    await app.click(fold("src/a.ts"));
    await app.click(get("button", "One file", panel()));
    expect(
      document.querySelector(".files-position")?.textContent,
      "the other view is there",
    ).toBe("1 of 3");
  } finally {
    items.mockRestore();
    logged.mockRestore();
  }
});

it("goes back to the beginning of the file that is chosen again", async () => {
  const app = await openAll({}, (bridge) =>
    bridge.respond("rangePatches", () =>
      patches().map((each) =>
        each.path === "src/a.ts"
          ? { ...each, patch: { ...each.patch, patch: longPatch("src/a.ts") } }
          : each,
      ),
    ),
  );
  const tree = get(
    "complementary",
    "Pull request details",
  ).querySelector<HTMLElement>("file-tree-container")!;
  const row = tree.shadowRoot!.querySelector("[aria-selected=true]")!;
  // As a click on the row is outside of the shadow.
  tree.click = () => {
    const click = new MouseEvent("click", { bubbles: true });
    const path = click.composedPath.bind(click);
    click.composedPath = () => [row, ...path()];
    tree.dispatchEvent(click);
  };
  const scrollTo = vi.spyOn(CodeView.prototype, "scrollTo");
  const scroller = get("region", "All changed files", panel());
  scroller.scrollTop = 500;
  scroller.dispatchEvent(new Event("scroll"));
  await app.click(tree);
  expect(scrollTo).toHaveBeenCalledWith({ type: "item", id: "0.0", offset: 0 });
  scrollTo.mockRestore();
});

it("tabs from the files to the first header in the view", async () => {
  await openAll();
  const files = get("region", "All changed files", panel());
  files.focus();
  const tabbed = new KeyboardEvent("keydown", {
    key: "Tab",
    bubbles: true,
    cancelable: true,
  });
  files.dispatchEvent(tabbed);
  expect(tabbed.defaultPrevented).toBe(true);
  expect(focused()).toBe("button src/a.ts");
});

it("stops at a file that is not read, and goes on from there", async () => {
  const held: { release: () => void }[] = [];
  const app = await openAll({}, (bridge) => {
    bridge.respond("rangePatches", () =>
      patches().map((each) =>
        each.path === "src/new.ts" ? { ...each, patch: null } : each,
      ),
    );
    bridge.respond("filePatch", () => ({
      kind: "text",
      patch: longPatch("src/new.ts", "src/old.ts"),
      lossy: false,
    }));
    held.push(bridge.hold("filePatch"));
  });
  const scrollTo = vi.spyOn(CodeView.prototype, "scrollTo");
  await app.press("n");
  await app.press("n");
  expect(selected()).toBe("src/new.ts");
  await app.press("n");
  expect(selected(), "it waits").toBe("src/new.ts");
  scrollTo.mockClear();
  held[0]!.release();
  await frames(app);
  expect(scrollTo).toHaveBeenCalledWith(
    expect.objectContaining({ type: "line", id: "1.0", lineNumber: 60 }),
  );
  await app.press("p");
  expect(selected()).toBe("src/a.ts");
  scrollTo.mockRestore();
});

it("passes over a file that could not be read", async () => {
  const app = await openAll({}, (bridge) => {
    bridge.respond("rangePatches", () =>
      patches().map((each) =>
        each.path === "src/a.ts" ? { ...each, patch: null } : each,
      ),
    );
    bridge.respond("filePatch", () => {
      throw new Error("not now");
    });
  });
  await app.press("n");
  expect(selected()).toBe("src/new.ts");
  await frames(app);
  await app.press("p");
  await frames(app);
  expect(selected(), "nothing before it").toBe("src/new.ts");
});

it("shows threads on their lines, and the rest over the file", async () => {
  const app = await openAll({
    threads: page([
      thread("one"),
      thread("moved", { path: "src/new.ts", side: "left" }),
      thread("outdated", { outdated: true }),
      thread("logo", { path: "src/z.png", line: null }),
    ]),
  });
  const chips = () =>
    [...panel().querySelectorAll(".thread-chip-row, .threads-elsewhere-row")]
      .map(({ textContent }) => textContent)
      .sort();
  expect(chips()).toEqual([
    "1 comment that isn't on a line here",
    "1 comment that isn't on a line here",
    "S1 commentsara: “Says moved”",
    "S1 commentsara: “Says one”",
  ]);
  await app.click(get("button", /Says one/, panel()));
  await app.click(get("button", "One file", panel()));
  expect(
    get("button", /Says one/, panel()).getAttribute("aria-expanded"),
    "what is unfolded is so in both views",
  ).toBe("true");
  await app.click(get("button", "All files", panel()));
  await frames(app);
  const { details } = app.bridge.world.host;
  details.set(
    pullKey("octo/pin", 1),
    pull(1, { ...counts, threads: page([thread("one"), thread("two")]) }),
  );
  await app.click(refresh());
  await frames(app);
  expect(chips()).toEqual([
    "S1 commentsara: “Says one”",
    "S1 commentsara: “Says two”",
  ]);
});

it("reads a file by itself when it comes near, and again when asked", async () => {
  let fails = true;
  const app = await openAll({}, (bridge) => {
    bridge.respond("rangePatches", () =>
      patches().map((each) =>
        each.path === "src/new.ts" ? { ...each, patch: null } : each,
      ),
    );
    bridge.respond("filePatch", ({ file, from }) => {
      if (fails) throw new Error("not now");
      return {
        kind: "text",
        patch: patchOf(String(file), String(from)),
        lossy: false,
      };
    });
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  await frames(app);
  const reads = () =>
    app.bridge.log.flatMap(({ op, file }) =>
      op === "filePatch" ? [file] : [],
    );
  expect(reads()).toEqual(["src/new.ts"]);
  expect(panel().textContent).toContain("Couldn't read this file's changes.");
  fails = false;
  const again = get("button", "Try again", panel());
  again.focus();
  await app.click(again);
  await frames(app);
  expect(reads()).toEqual(["src/new.ts", "src/new.ts"]);
  expect(panel().textContent).not.toContain("Couldn't read");
  expect(focused()).toBe("region Files changed");
});

it("shows every state a file can be in without its contents", async () => {
  await openAll({}, (bridge) =>
    bridge.respond("rangeFiles", () => ({
      kind: "ready",
      mergeBase: oid("a"),
      files,
      contentMissing: true,
      shallow: false,
    })),
  );
  expect(panel().textContent?.split("This is a partial clone")).toHaveLength(4);
});
