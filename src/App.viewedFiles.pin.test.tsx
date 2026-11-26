// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
import type { PullRequest, ReviewThread } from "./domain/pullRequest";
import type { RangeFile } from "./domain/range";
import { oidSchema } from "./domain/repository";
import {
  focused,
  get,
  installHarness,
  paletteTitles,
  query,
  queryAll,
} from "./test/appHarness";
import type { Harness } from "./test/appHarness";
import { pullKey } from "./test/fakeBridge";
import type { Bridge } from "./test/fakeBridge";
import {
  at,
  open,
  page,
  pull as anyPull,
  refresh,
  tab,
  visit,
} from "./test/pullRequests";

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

const KEY = "l1git.viewed.v1";
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
const files = [file("src/a.ts"), file("src/b.ts"), file("src/z.png")];
const pull = (fields: Partial<PullRequest> = {}) =>
  anyPull(1, { changedFiles: 3, additions: 6, deletions: 3, ...fields });
const listed = (changed: readonly RangeFile[]) => ({
  kind: "ready",
  mergeBase: oid("a"),
  files: changed,
  contentMissing: false,
  shallow: false,
});

async function openFiles(
  view: "one" | "all" = "one",
  stored: Record<string, string> = {},
  more: (bridge: Bridge) => void = () => {},
  fields: Partial<PullRequest> = {},
): Promise<Harness> {
  const app = await visit({
    stored: {
      "l1git.filesChanged.v1": JSON.stringify({
        version: 1,
        diffStyle: "unified",
        view,
      }),
      ...stored,
    },
    world: ({ host }) => {
      host.details.set(pullKey("octo/pin", 1), pull(fields));
    },
    bridge: (bridge) => {
      bridge.respond("rangeFiles", () => listed(files));
      bridge.respond("rangePatches", () =>
        files.map(({ path }) => ({
          path,
          patch:
            path === "src/z.png"
              ? { kind: "binary" }
              : {
                  kind: "text",
                  patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -10,3 +10,4 @@\n one\n-two\n+TWO\n+and\n three\n`,
                  lossy: false,
                },
        })),
      );
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
const place = () => document.querySelector(".files-position")?.textContent;
const box = (name = "Viewed") => {
  const input = get("checkbox", name, panel());
  if (!(input instanceof HTMLInputElement)) throw new Error("No checkbox");
  return input;
};
const inspector = () => get("complementary", "Pull request details");
const progress = () => document.querySelector(".files-progress")?.textContent;
const checked = () =>
  [
    ...(inspector()
      .querySelector("file-tree-container")
      ?.shadowRoot?.querySelectorAll("[data-item-type=file]") ?? []),
  ].flatMap((row) =>
    row.querySelector("[style*='--viewed']")
      ? [row.getAttribute("data-item-path")]
      : [],
  );
const end = () =>
  [...(panel().querySelector(".files-next")?.children ?? [])].map(
    ({ textContent }) => textContent,
  );
const press = (name: string) =>
  get("button", name, panel().querySelector(".files-next")!);
const folds = () =>
  queryAll("button", /^src/, panel()).map((each) =>
    each.getAttribute("aria-expanded"),
  );
const stored = () =>
  (
    JSON.parse(localStorage.getItem(KEY) ?? '{"pulls":[]}') as {
      pulls: { pull: string; marks: string[] }[];
    }
  ).pulls.map(({ pull, marks }) => [pull, marks.length]);

it("marks the current file with its checkbox and with V, and keeps it", async () => {
  const app = await openFiles();
  expect(progress()).toBe("Viewed0 of 3");
  await app.click(box());
  expect(box().checked).toBe(true);
  expect(place(), "marking moves nothing").toBe("1 of 3");
  expect(progress()).toBe("Viewed1 of 3");
  expect(checked()).toEqual(["src/a.ts"]);
  expect(box().closest("label")?.title).toBe("Viewed (V)");
  await app.press("j");
  expect(box().checked).toBe(false);
  await app.press("v");
  expect(box().checked).toBe(true);
  expect(place()).toBe("2 of 3");
  await app.press("v", { repeat: true });
  expect(box().checked, "a key that is held").toBe(true);
  await app.press("v");
  expect(box().checked).toBe(false);
  expect(stored()).toEqual([["octo/pin#1", 1]]);
  await app.click(get("button", "Pull requests"));
  await open(app, 1);
  await app.click(tab("Files changed"));
  expect(progress()).toBe("Viewed1 of 3");
  expect(box().checked).toBe(true);
});

it("says nothing new to a screen reader but the checkbox", async () => {
  const app = await openFiles();
  const said = () =>
    queryAll("status", /./, panel()).map(({ textContent }) => textContent);
  const before = said();
  await app.press("v");
  expect(box().checked).toBe(true);
  expect(said()).toEqual(before);
});

it("goes to the next file that isn't viewed from the end of one", async () => {
  const app = await openFiles();
  expect(end()).toEqual(["Mark viewed", "Mark viewed, next file"]);
  await app.press("j");
  await app.press("v");
  await app.press("k");
  press("Mark viewed, next file").focus();
  await app.click(press("Mark viewed, next file"));
  expect(place(), "past the one that is viewed").toBe("3 of 3");
  expect(focused()).toBe("region src/z.png");
  expect(progress()).toBe("Viewed2 of 3");
  expect(end(), "it is the last one").toEqual(["Mark viewed"]);
  expect(press("Mark viewed").title).toBe("Mark viewed (V)");
  press("Mark viewed").focus();
  await app.click(press("Mark viewed"));
  expect(place()).toBe("3 of 3");
  expect(focused()).toBe("button Mark unviewed");
  expect(end()).toEqual(["All files viewed", "Mark unviewed"]);
  await app.press("k");
  expect(end()).toEqual(["All files viewed", "Mark unviewed", "Next file"]);
  await app.click(press("Mark unviewed"));
  await app.press("j");
  expect(end()).toEqual(["Mark unviewed", "Next unviewed file"]);
  await app.click(press("Next unviewed file"));
  expect(place(), "it begins again at the top").toBe("2 of 3");
  expect(progress(), "and marks nothing").toBe("Viewed2 of 3");
});

it("drops the mark of a file that changes, and has it again when it goes back", async () => {
  const app = await openFiles();
  await app.press("v");
  await app.press("j");
  await app.press("v");
  let changed: readonly RangeFile[] = files.with(
    1,
    file("src/b.ts", { newBlob: oid("3") }),
  );
  app.bridge.respond("rangeFiles", () => listed(changed));
  const push = async (head: string) => {
    app.bridge.world.host.details.set(
      pullKey("octo/pin", 1),
      pull({ head: { ...pull().head, oid: oid(head) } }),
    );
    await app.click(refresh());
    expect(progress(), "until asked").toBe(
      head === "9" ? "Viewed2 of 3" : "Viewed1 of 3",
    );
    await app.click(get("button", "Show them", panel()));
  };
  await push("9");
  expect(progress()).toBe("Viewed1 of 3");
  expect(checked()).toEqual(["src/a.ts"]);
  changed = files;
  await push("8");
  expect(progress()).toBe("Viewed2 of 3");
  expect(checked()).toEqual(["src/a.ts", "src/b.ts"]);
});

it("marks for the session when it can't save, and says so once", async () => {
  const app = await openFiles();
  const spy = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
    throw new DOMException("full", "QuotaExceededError");
  });
  try {
    await app.press("v");
    expect(box().checked).toBe(true);
    expect(panel().textContent).toContain(
      "Viewed files changed for this session. Could not save them.",
    );
    await app.click(get("button", "Dismiss", panel()));
    expect(focused()).toBe("region src/a.ts");
    await app.press("j");
    await app.press("v");
    expect(progress()).toBe("Viewed2 of 3");
    expect(panel().textContent).not.toContain("Could not save");
  } finally {
    spy.mockRestore();
  }
});

it("folds a file that is marked, and unfolds it when it isn't", async () => {
  const app = await openFiles("all");
  const count = () =>
    document.querySelector(".files-viewed-count")?.textContent;
  expect(folds()).toEqual(["true", "true", "true"]);
  expect(count()).toBe("· Viewed 0 of 3");
  await app.click(box("Viewed, src/b.ts"));
  await frames(app);
  expect(folds()).toEqual(["true", "false", "true"]);
  expect(count()).toBe("· Viewed 1 of 3");
  await app.press("v");
  await frames(app);
  expect(folds(), "V marks the current one").toEqual([
    "false",
    "false",
    "true",
  ]);
  await app.press("v");
  await frames(app);
  expect(folds()).toEqual(["true", "false", "true"]);
  const unfold = get("button", "src/b.ts", panel());
  await app.click(unfold);
  await frames(app);
  expect(folds(), "a look at it again").toEqual(["true", "true", "true"]);
  expect(box("Viewed, src/b.ts").checked).toBe(true);
  await app.click(box("Viewed, src/b.ts"));
  await frames(app);
  expect(folds()).toEqual(["true", "true", "true"]);
  await app.click(unfold);
  await app.click(box("Viewed, src/b.ts"));
  await app.click(box("Viewed, src/b.ts"));
  await frames(app);
  expect(folds(), "a mark goes before a hand").toEqual([
    "true",
    "true",
    "true",
  ]);
});

it("marks from the end of a file, and keeps the focus", async () => {
  const app = await openFiles("all");
  const ends = () =>
    [...panel().querySelectorAll(".files-end")].map(
      ({ textContent }) => textContent,
    );
  expect(ends()).toEqual([
    "End ofsrc/a.tsVMark viewed",
    "End ofsrc/b.tsMark viewed",
    "End ofsrc/z.pngMark viewed",
  ]);
  const mark = get("button", "Mark viewed, src/b.ts", panel());
  mark.focus();
  await app.click(mark);
  await frames(app);
  expect(folds()).toEqual(["true", "false", "true"]);
  expect(focused()).toBe("region All changed files");
  expect(ends()).toHaveLength(2);
  await app.click(get("button", "src/b.ts", panel()));
  await frames(app);
  await app.click(get("button", "Mark unviewed, src/b.ts", panel()));
  await frames(app);
  expect(box("Viewed, src/b.ts").checked).toBe(false);
  expect(folds()).toEqual(["true", "true", "true"]);
});

it("keeps the focus on the header of a file that V folds from a note", async () => {
  const thread: ReviewThread = {
    id: "one",
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
    comments: page([{ id: "one-1", by: "sara", at: at(2), body: "Says one" }]),
  };
  const app = await openFiles("all", {}, () => {}, {
    threads: page([thread]),
  });
  get("button", /Says one/, panel()).focus();
  await app.press("v");
  await frames(app);
  expect(folds()).toEqual(["false", "true", "true"]);
  expect(focused()).toBe("button src/a.ts");
});

it("opens with the viewed files folded, and says so in both views", async () => {
  const mark = (path: string) =>
    `${"1".repeat(16)} ${"2".repeat(16)} 100644 100644 ${path}`;
  const app = await openFiles("all", {
    [KEY]: JSON.stringify({
      version: 1,
      pulls: [
        { pull: "octo/pin#1", marks: [mark("src/a.ts"), mark("src/z.png")] },
        { pull: "octo/pin#2", marks: [mark("src/b.ts")] },
      ],
    }),
  });
  expect(folds()).toEqual(["false", "true", "false"]);
  expect(checked()).toEqual(["src/a.ts", "src/z.png"]);
  await app.click(get("button", "One file", panel()));
  expect(box().checked).toBe(true);
  await app.press("p", { ctrlKey: true });
  expect(paletteTitles()).toContain("Mark file unviewed");
});

it("has nothing to mark without files", async () => {
  await openFiles("one", {}, (bridge) =>
    bridge.respond("rangeFiles", () => listed([])),
  );
  expect(query("checkbox", "Viewed", panel())).toBeNull();
  expect(progress()).toBeUndefined();
});
