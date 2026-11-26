// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { VirtualizedFileDiff } from "@pierre/diffs";
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
import type { Bridge, World } from "./test/fakeBridge";
import { PIN } from "./test/fixtures";
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
  submodule: false,
  ...fields,
});
const patchOf = (path: string, from = path) =>
  `diff --git a/${from} b/${path}\n--- a/${from}\n+++ b/${path}\n@@ -10,3 +10,4 @@\n one\n-two\n+TWO\n+and\n three\n`;
const files = [
  file("src/a.ts"),
  file("src/new.ts", { status: "R", from: "src/old.ts", similarity: 94 }),
  file("src/z.png", { added: null, deleted: null }),
];
const ready = (listed = files, contentMissing = false) => ({
  kind: "ready",
  mergeBase: oid("a"),
  files: listed,
  contentMissing,
  shallow: false,
});
const pull = (number: number, fields: Partial<PullRequest> = {}) =>
  anyPull(number, {
    changedFiles: 3,
    additions: 4,
    deletions: 2,
    ...fields,
  });

function answer(bridge: Bridge) {
  bridge.respond("rangeFiles", () => ready());
  bridge.respond("rangePatches", () =>
    files.map(({ path, from }) => ({
      path,
      patch:
        path === "src/z.png"
          ? { kind: "binary" }
          : { kind: "text", patch: patchOf(path, from ?? path), lossy: false },
    })),
  );
}
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
  comments: page([
    { id: `${id}-1`, by: "sara", at: at(2), body: `Says ${id}` },
  ]),
  ...fields,
});
const detail = (fields: Partial<PullRequest> = {}) => ({
  world: (world: World) => {
    world.host.details.set(pullKey("octo/pin", 1), pull(1, fields));
  },
});

const reads = (bridge: Bridge) =>
  bridge.log.flatMap(({ op }) =>
    /^(?:range|fetchCommits|filePatch)/.test(op) ? [op] : [],
  );
const panel = () => get("tabpanel", /^Files changed/);
const place = () => document.querySelector(".files-position")?.textContent;
const path = () => document.querySelector(".file-diff-path")?.textContent;
const chips = () =>
  [...document.querySelectorAll(".thread-chip-row")].map(
    (row) => row.textContent,
  );
async function openFiles(
  more: Parameters<typeof visit>[0] = {},
  number = 1,
): Promise<Harness> {
  const app = await visit({
    ...more,
    bridge: (bridge) => {
      answer(bridge);
      more?.bridge?.(bridge);
    },
    world: (world) => {
      world.host.details.set(pullKey("octo/pin", 1), pull(1));
      more?.world?.(world);
    },
  });
  await open(app, number);
  await app.click(tab("Files changed"));
  return app;
}
async function backToList(app: Harness) {
  await app.click(get("button", "Pull requests"));
}

it("reads nothing before the tab is opened, and then once", async () => {
  const app = await visit({ bridge: answer, ...detail() });
  await open(app, 1);
  await app.click(tab("Commits"));
  expect(reads(app.bridge)).toEqual([]);
  expect(tab("Files changed").textContent).toBe("Files changed3");
  await app.click(tab("Files changed"));
  expect(reads(app.bridge)).toEqual(["rangeFiles", "rangePatches"]);
  expect(app.bridge.log.find(({ op }) => op === "rangeFiles")).toMatchObject({
    path: PIN,
    base: oid("b"),
    head: oid("1"),
  });
  expect(place()).toBe("1 of 3");
  expect(path()).toBe("src/a.ts");
  expect(panel().textContent).toContain("+2−1");
  expect(get("link", "Open on GitHub").getAttribute("href")).toBe(
    "https://github.com/octo/pin/pull/1/files",
  );
  await app.click(tab("Conversation"));
  await app.click(tab("Files changed"));
  await app.click(refresh());
  expect(reads(app.bridge)).toEqual(["rangeFiles", "rangePatches"]);
});

it("steps through the files with its buttons and with J and K", async () => {
  const app = await openFiles();
  const previous = get("button", "Previous file");
  expect(previous.title).toBe("Previous file (K)");
  expect(previous.getAttribute("aria-disabled")).toBe("true");
  await app.press("j");
  expect(place()).toBe("2 of 3");
  expect(path()).toBe("src/{old.ts → new.ts}");
  expect(panel().textContent).toContain("Renamed");
  expect(panel().textContent).toContain(
    "Moved from src/old.ts · 94% the same.",
  );
  await app.click(
    get("button", "Next file", document.querySelector("header.files-toolbar")!),
  );
  expect(path()).toBe("src/z.png");
  expect(panel().textContent).toContain(
    "Binary file. L1 Git does not display binary changes.",
  );
  expect(get("button", "Next file").getAttribute("aria-disabled")).toBe("true");
  await app.press("j");
  expect(place(), "there is no file after the last").toBe("3 of 3");
  await app.press("k");
  await app.press("k");
  await app.press("k");
  expect(place()).toBe("1 of 3");
  expect(reads(app.bridge)).toEqual(["rangeFiles", "rangePatches"]);
});

it("goes to the next file from the end of one, and keeps the focus in it", async () => {
  const app = await openFiles();
  const end = get(
    "button",
    "Next file",
    document.querySelector(".files-next")!,
  );
  expect(end.title).toBe("Next file (J)");
  end.focus();
  await app.click(end);
  expect(path()).toBe("src/{old.ts → new.ts}");
  expect(focused()).toBe("region src/new.ts");
  await app.press("j");
  expect(focused()).toBe("region src/z.png");
});

it("keeps its letters to itself while something else takes keys", async () => {
  const app = await openFiles();
  const filter = get("textbox", "Filter changed files");
  filter.focus();
  await app.press("j");
  await app.press("Escape");
  expect(place()).toBe("1 of 3");
  get(
    "button",
    "Next file",
    document.querySelector("header.files-toolbar")!,
  ).focus();
  for (const held of ["ctrlKey", "metaKey", "altKey", "shiftKey"])
    await app.press("j", { [held]: true });
  expect(place()).toBe("1 of 3");
  const menu = document.body.appendChild(document.createElement("div"));
  menu.setAttribute("role", "menu");
  await app.press("j");
  expect(place()).toBe("1 of 3");
  menu.remove();
  await app.press("p", { ctrlKey: true });
  await app.press("j");
  expect(paletteTitles()).toContain("Next file");
  expect(paletteTitles()).not.toContain("Previous file");
  await app.press("Escape");
  expect(place()).toBe("1 of 3");
  await app.click(get("button", "Settings"));
  await app.press("j");
  await app.press("Escape");
  expect(place()).toBe("1 of 3");
  await app.click(tab("Commits"));
  await app.press("j");
  await app.click(tab("Files changed"));
  expect(place()).toBe("1 of 3");
});

it("goes on to another file when a file has no other change", async () => {
  const app = await openFiles();
  await app.press("n");
  expect(place()).toBe("2 of 3");
  await app.press("n");
  expect(place()).toBe("3 of 3");
  await app.press("n");
  expect(place()).toBe("3 of 3");
  await app.press("p");
  expect(place()).toBe("2 of 3");
});

it("keeps Unified or Split for the next time", async () => {
  const app = await openFiles();
  expect(get("button", "Unified").getAttribute("aria-pressed")).toBe("true");
  await app.click(get("button", "Split"));
  expect(localStorage.getItem("l1git.filesChanged.v1")).toBe(
    '{"version":1,"diffStyle":"split","view":"one"}',
  );
  for (const [stored, expected] of [
    ['{"version":1,"diffStyle":"split"}', "Split"],
    ['{"version":2}', "Unified"],
  ] as const) {
    const app = await visit({
      bridge: answer,
      stored: { "l1git.filesChanged.v1": stored },
    });
    await open(app, 1);
    await app.click(tab("Files changed"));
    expect(get("button", expected).getAttribute("aria-pressed")).toBe("true");
  }
});

it("fetches missing commits once, and says so while it does", async () => {
  let fetched = false;
  const held: ReturnType<Bridge["hold"]>[] = [];
  const app = await openFiles({
    bridge: (bridge) => {
      bridge.respond("rangeFiles", (_, __, fallback) =>
        fetched ? fallback() : { kind: "missing", oids: [oid("1")] },
      );
      bridge.respond("fetchCommits", () => {
        fetched = true;
        return { kind: "done" };
      });
      held.push(bridge.hold("fetchCommits"));
    },
  });
  expect(panel().textContent).toContain("Getting the commits from GitHub…");
  expect(app.bridge.log.find(({ op }) => op === "fetchCommits")).toMatchObject({
    path: PIN,
    github: { owner: "octo", repo: "pin" },
    oids: [oid("1")],
  });
  await app.click(tab("Commits"));
  expect(get("tabpanel", /^Commits/).textContent).toContain("Read it");
  await backToList(app);
  expect(get("link", /^Row 1,/)).toBeTruthy();
  held[0]!.release();
  await app.settle();
  expect(query("tabpanel", /^Files changed/)).toBeNull();
  expect(app.bridge.count("rangePatches")).toBe(0);
  await open(app, 1);
  expect(tab("Conversation").getAttribute("aria-selected")).toBe("true");
  await app.click(tab("Files changed"));
  expect(place()).toBe("1 of 3");
  expect(app.bridge.count("fetchCommits")).toBe(1);
});

it("says why a fetch failed, and tries again only when asked", async () => {
  const app = await openFiles({
    bridge: (bridge) => {
      bridge.respond("rangeFiles", () => ({
        kind: "missing",
        oids: [oid("b"), oid("1")],
      }));
      bridge.respond("fetchCommits", () => ({
        kind: "failed",
        failure: "network",
        message: "Could not resolve host.",
      }));
    },
  });
  expect(panel().textContent).toContain(
    "Couldn't get the commitsNetwork error. Could not resolve host.",
  );
  expect(get("link", "Open on GitHub", panel()).getAttribute("href")).toBe(
    "https://github.com/octo/pin/pull/1/files",
  );
  await app.click(tab("Commits"));
  await app.click(tab("Files changed"));
  await app.click(refresh());
  expect(app.bridge.count("fetchCommits")).toBe(1);
  await app.click(get("button", "Try again"));
  expect(app.bridge.count("fetchCommits")).toBe(2);
});

it.each([
  [
    "a shallow clone",
    () => ({ kind: "unrelated", shallow: true }),
    "This is a shallow clone, and the commit where this pull request starts isn't in it.",
  ],
  [
    "two histories",
    () => ({ kind: "unrelated", shallow: false }),
    "This pull request and its base have no commit in common.",
  ],
  ["no files", () => ready([]), "No changes."],
  [
    "a partial clone",
    () => ready(files, true),
    "This is a partial clone, and file contents aren't on this computer.",
  ],
  [
    "a partial clone without folders",
    () => ({ kind: "treesMissing" }),
    "This is a partial clone, and file contents aren't on this computer.",
  ],
])("says what there is to say about %s", async (_, found, words) => {
  const app = await openFiles({
    ...(_ === "no files" &&
      detail({ changedFiles: 0, additions: 0, deletions: 0 })),
    bridge: (bridge) => bridge.respond("rangeFiles", found),
  });
  expect(panel().textContent).toContain(words);
  expect(get("link", "Open on GitHub", panel())).toBeTruthy();
  expect(reads(app.bridge)).toEqual(["rangeFiles"]);
});

it("says when GitHub counts otherwise, and shows the diff", async () => {
  const app = await openFiles(detail({ changedFiles: 14, additions: 612 }));
  const notice = panel().querySelector<HTMLElement>(".files-counts")!;
  expect(notice.textContent).toBe(
    "GitHub counts 14 files, +612 −2. This shows 3 files, +4 −2. Open on GitHub",
  );
  expect(get("link", "Open on GitHub", notice).getAttribute("href")).toBe(
    "https://github.com/octo/pin/pull/1/files",
  );
  expect(place()).toBe("1 of 3");
  const { details } = app.bridge.world.host;
  details.set(pullKey("octo/pin", 1), pull(1));
  await app.click(refresh());
  expect(panel().querySelector(".files-counts")).toBeNull();
  details.set(pullKey("octo/pin", 1), pull(1, { changedFiles: 14 }));
  await app.click(refresh());
  expect(panel().querySelector(".files-counts")?.textContent).toMatch(
    /^GitHub/,
  );
});

it("shows no diff of a shallow clone that GitHub counts otherwise", async () => {
  await openFiles({
    ...detail({ changedFiles: 2 }),
    bridge: (bridge) =>
      bridge.respond("rangeFiles", () => ({ ...ready(), shallow: true })),
  });
  expect(panel().textContent).toContain("This is a shallow clone");
  expect(place()).toBeUndefined();
});

it("says that its clone is gone, and reads it when it is back", async () => {
  let back = () => {};
  const app = await openFiles({
    bridge: (bridge) => {
      back = bridge.fail("rangeFiles", {
        kind: "missingPath",
        message: "The folder is gone.",
      });
    },
  });
  expect(panel().textContent).toContain(
    "Couldn't read the changesThe folder is gone.",
  );
  back();
  const again = get("button", "Try again");
  again.focus();
  await app.click(again);
  expect(place()).toBe("1 of 3");
  expect(focused()).toBe("region src/a.ts");
});

it("keeps what it shows when more is pushed, until asked", async () => {
  const app = await openFiles();
  await app.press("j");
  const { details } = app.bridge.world.host;
  const forced = {
    id: "F2",
    kind: "forcePushed" as const,
    from: oid("1"),
    to: oid("2"),
    by: "maja",
    at: at(3),
  };
  const newer = pull(1, {
    head: { ...pull(1).head, oid: oid("2") },
    timeline: page([forced]),
    changedFiles: 9,
  });
  details.set(pullKey("octo/pin", 1), newer);
  await app.click(refresh());
  const notice = () => panel().querySelector(".notice")?.textContent ?? null;
  expect(notice()).toBe("maja pushed new commits.Show them");
  expect(place()).toBe("2 of 3");
  expect(tab("Files changed").textContent).toBe("Files changed9");
  expect(reads(app.bridge)).toEqual(["rangeFiles", "rangePatches"]);

  details.set(pullKey("octo/pin", 1), pull(1, { baseOid: oid("c") }));
  await app.click(refresh());
  expect(notice(), "a base that moved").toBeNull();
  details.set(pullKey("octo/pin", 1), pull(1, { base: "next" }));
  await app.click(refresh());
  expect(notice()).toBe("The base changed to next.Show it");

  details.set(pullKey("octo/pin", 1), newer);
  await app.click(refresh());
  const show = get("button", "Show them");
  show.focus();
  await app.click(show);
  expect(focused()).toBe("region src/new.ts");
  expect(notice()).toBeNull();
  expect(place(), "the same file").toBe("2 of 3");
  expect(
    app.bridge.log.findLast(({ op }) => op === "rangeFiles"),
  ).toMatchObject({ head: oid("2") });
});

it("shows threads on their lines, and the rest above", async () => {
  const app = await openFiles(
    detail({
      threads: page([
        thread("one"),
        thread("two", { resolved: true }),
        thread("old", { side: "left", line: 11 }),
        thread("outdated", { outdated: true }),
        thread("whole", { line: null }),
        thread("far", { line: 99 }),
        thread("moved", { path: "src/new.ts", side: "left", line: 11 }),
        thread("gone", { path: "src/gone.ts" }),
      ]),
    }),
  );
  expect(chips()).toEqual([
    "S1 commentsara: “Says one”",
    "S1 commentsara: “Says two”Resolved",
    "S1 commentsara: “Says old”",
  ]);
  const rest = get("button", "3 comments that aren't on a line here");
  expect(panel().textContent).not.toContain("Says whole");
  await app.click(rest);
  for (let frame = 0; frame < 5; frame += 1) await app.flushFrames();
  expect(panel().textContent).toContain("Says whole");
  expect(panel().textContent).toContain("Outdated");

  const chip = queryAll("button", /Says one/)[0]!;
  await app.click(chip);
  for (let frame = 0; frame < 5; frame += 1) await app.flushFrames();
  expect(chip.getAttribute("aria-expanded")).toBe("true");
  expect(chip.parentElement?.querySelector(".thread-comments")).not.toBeNull();
  expect(chip.parentElement?.querySelector(".thread-hunk")).toBeNull();

  await app.press("j");
  expect(chips()).toEqual(["S1 commentsara: “Says moved”"]);
  await app.press("k");
  expect(
    queryAll("button", /Says one/)[0]!.getAttribute("aria-expanded"),
    "it stays unfolded",
  ).toBe("true");
});

it("shows threads that come later, and none of another head", async () => {
  const app = await openFiles(detail({ threads: page([thread("one")]) }));
  const { details } = app.bridge.world.host;
  const key = pullKey("octo/pin", 1);
  details.set(key, pull(1, { threads: page([thread("one"), thread("two")]) }));
  await app.click(refresh());
  expect(chips()).toHaveLength(2);
  details.set(
    key,
    pull(1, {
      head: { ...pull(1).head, oid: oid("2") },
      threads: page([thread("three")]),
    }),
  );
  await app.click(refresh());
  expect(chips()).toEqual([
    "S1 commentsara: “Says one”",
    "S1 commentsara: “Says two”",
  ]);
});

it("keeps the threads it has when GitHub gives up on them", async () => {
  const app = await openFiles(detail({ threads: page([thread("one")]) }));
  const { details } = app.bridge.world.host;
  const key = pullKey("octo/pin", 1);
  const chip = queryAll("button", /Says one/)[0]!;
  chip.focus();
  details.set(key, pull(1, { threads: null }));
  await app.click(refresh());
  expect(chips()).toEqual(["S1 commentsara: “Says one”"]);
  expect(queryAll("button", /Says one/)[0]).toBe(chip);
  details.set(key, pull(1, { threads: page([]) }));
  await app.click(refresh());
  expect(chips(), "none is an answer").toEqual([]);
});

it("leaves the diff alone while something in it is selected", async () => {
  const app = await openFiles(detail({ threads: page([thread("one")]) }));
  const { details } = app.bridge.world.host;
  const key = pullKey("octo/pin", 1);
  const selection = getSelection()!;
  selection.selectAllChildren(document.querySelector(".thread-chip-words")!);
  details.set(key, pull(1, { threads: page([thread("one"), thread("two")]) }));
  await app.click(refresh());
  expect(chips()).toHaveLength(1);
  selection.removeAllRanges();
  document.dispatchEvent(new Event("selectionchange"));
  await app.settle();
  expect(chips()).toHaveLength(2);
});

it("says that a file's mode changed with its lines", async () => {
  const app = await openFiles({
    bridge: (bridge) =>
      bridge.respond("rangePatches", () =>
        files.map(({ path, from }) => ({
          path,
          patch: {
            kind: "text",
            lossy: false,
            patch: patchOf(path, from ?? path).replace(
              "\n",
              "\nold mode 100644\nnew mode 100755\n",
            ),
          },
        })),
      ),
  });
  expect(panel().querySelector(".files-moved")?.textContent).toBe(
    "Made executable.",
  );
  await app.press("j");
  expect(panel().querySelector(".files-moved")?.textContent).toBe(
    "Moved from src/old.ts · 94% the same. Made executable.",
  );
});

it("says why it can't show more lines of a file", async () => {
  const app = await openFiles({
    bridge: (bridge) =>
      bridge.respond("filePatch", () => ({
        kind: "tooLarge",
        bytes: 3 * 1024 * 1024,
      })),
  });
  const host = panel().querySelector("diffs-container")!;
  const expander = host.shadowRoot!.querySelector<HTMLElement>(
    "[data-expand-button]",
  )!;
  expect(expander.tabIndex).toBe(0);
  expect(expander.getAttribute("aria-label")).toBe("Show 9 unmodified lines");
  expander.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
  );
  await app.settle();
  const notice = () => panel().querySelector<HTMLElement>(".notice");
  expect(notice()?.textContent).toBe(
    "Couldn't show more lines. With all of its lines, this change is 3.0 MiB, above the 1 MiB display limit.",
  );
  await app.click(get("button", "Dismiss", notice()!));
  expect(notice()).toBeNull();
  await app.click(expander);
  await app.press("j");
  expect(notice(), "it is about the other file").toBeNull();
});

it("shows the characters that would turn a path around", async () => {
  const path = "src/evil\u202egpj.ts";
  const app = await openFiles({
    bridge: (bridge) => {
      bridge.respond("rangeFiles", () => ready([file(path)]));
      bridge.respond("rangePatches", () => [
        { path, patch: { kind: "text", patch: patchOf(path), lossy: false } },
      ]);
    },
  });
  await app.settle();
  expect(panel().textContent).toContain("src/evil<U+202E>gpj.ts");
  const row = get("complementary", "Pull request details")
    .querySelector("file-tree-container")!
    .shadowRoot!.querySelector("[data-item-type=file]")!;
  expect(row.getAttribute("aria-label")).toBe("evil<U+202E>gpj.ts");
  expect(row.getAttribute("aria-selected")).toBe("true");
});

it("lists the files beside them, and goes to the one that is chosen", async () => {
  const app = await openFiles(
    detail({ threads: page([thread("one"), thread("two")], 40) }),
  );
  const inspector = get("complementary", "Pull request details");
  expect(inspector.textContent).toMatch(
    /^Pull request detailsReviewers.*Changed files3\+4−2/,
  );
  expect(inspector.textContent).toContain(
    "2 of 40 review threads are shown. Open on GitHub",
  );
  expect(inspector.textContent).not.toContain("Merges into");
  const rows = () => inspector.querySelector("file-tree-container")?.shadowRoot;
  expect(rows()?.querySelector("[title='2 comments']")?.textContent).toBe("2");
  const row = (path: string) =>
    rows()!.querySelector<HTMLElement>(`[data-item-path="${path}"]`)!;
  await app.click(row("src/z.png"));
  expect(place()).toBe("3 of 3");
  await app.press("k");
  expect(row("src/new.ts").getAttribute("aria-selected")).toBe("true");
  expect(row("src/z.png").getAttribute("aria-selected")).toBe("false");
  await app.click(tab("Checks"));
  expect(inspector.textContent).toContain("Merges into");
});

it("goes back to the beginning of the file that is chosen again", async () => {
  const app = await openFiles();
  const tree = get(
    "complementary",
    "Pull request details",
  ).querySelector<HTMLElement>("file-tree-container")!;
  const row = () =>
    tree.shadowRoot!.querySelector<HTMLElement>(
      '[data-item-path="src/new.ts"]',
    )!;
  await app.click(row());
  expect(place()).toBe("2 of 3");
  const scrollTo = vi.spyOn(HTMLElement.prototype, "scrollTo");
  // As a click on the row is outside of the shadow.
  tree.click = () => {
    const click = new MouseEvent("click", { bubbles: true });
    const path = click.composedPath.bind(click);
    click.composedPath = () => [row(), ...path()];
    tree.dispatchEvent(click);
  };
  await app.click(tree);
  expect(scrollTo).toHaveBeenCalledWith({ top: 0 });
  expect(place()).toBe("2 of 3");
  scrollTo.mockRestore();
});

it("shows a message when drawing a file fails, and draws it when asked", async () => {
  const app = await openFiles();
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const draw = vi.spyOn(VirtualizedFileDiff.prototype, "render");
  try {
    draw.mockImplementation(() => {
      throw new Error("not this one");
    });
    await app.press("j");
    expect(panel().textContent).toContain("Couldn't show the changes");
    expect(get("link", "Open on GitHub", panel()).getAttribute("href")).toBe(
      "https://github.com/octo/pin/pull/1/files",
    );
    draw.mockRestore();
    await app.click(get("button", "Try again", panel()));
    expect(panel().textContent).not.toContain("Couldn't show");
    expect(focused()).toBe("region src/new.ts");
    await app.press("k");
    expect(place()).toBe("1 of 3");
  } finally {
    draw.mockRestore();
    logged.mockRestore();
  }
});

it("shows nothing to the next sign-in, and reads nothing for it", async () => {
  const held: ReturnType<Bridge["hold"]>[] = [];
  const app = await openFiles({
    bridge: (bridge) => held.push(bridge.hold("rangeFiles")),
  });
  app.bridge.world.host.status = {
    ...app.bridge.world.host.status,
    revision: app.bridge.world.host.status.revision + 1,
    github: {
      kind: "connected",
      login: "ada",
      api: "https://api.github.com/",
      method: "gh",
      access: "private",
      connectedAt: 2,
    },
  };
  await app.click(refresh());
  expect(tab("Conversation").getAttribute("aria-selected")).toBe("true");
  held[0]!.release();
  await app.settle();
  expect(query("tabpanel", /^Files changed/)).toBeNull();
  expect(app.bridge.count("rangeFiles")).toBe(1);
  expect(app.bridge.count("rangePatches")).toBe(0);
});

it("reads a file by itself when its patch isn't among the others", async () => {
  const app = await openFiles({
    bridge: (bridge) => {
      bridge.respond("rangePatches", () =>
        files.map(({ path }) => ({ path, patch: null })),
      );
      bridge.respond("filePatch", ({ file, from }) => ({
        kind: "text",
        patch: patchOf(String(file), String(from)),
        lossy: false,
      }));
    },
  });
  await app.press("j");
  expect(
    app.bridge.log.flatMap(({ op, file, from, context }) =>
      op === "filePatch" ? [{ file, from, context }] : [],
    ),
  ).toEqual([
    { file: "src/a.ts", from: "src/a.ts", context: "hunks" },
    { file: "src/new.ts", from: "src/old.ts", context: "hunks" },
  ]);
});
