// @vitest-environment happy-dom
import { expect, it } from "vitest";
import {
  dialogs,
  focused,
  get,
  historyRow,
  inspectorTitle,
  installHarness,
  mountApp,
  paletteTitles,
  query,
  refRow,
  repositoryRow,
  selectedRow,
} from "./test/appHarness";
import type { Harness } from "./test/appHarness";
import {
  activeMerge,
  OTHER,
  OTHER_TIP,
  PIN,
  PIN_FEATURE,
} from "./test/fixtures";
import { oidSchema, snapshotSchema } from "./domain/repository";
import { COMMIT_SUMMARY_ID } from "./components/CommitBox";

installHarness();

async function openPalette(app: Harness) {
  await app.press("p", { ctrlKey: true, target: document.body });
  return paletteTitles();
}

it("palette titles with no repository open", async () => {
  const empty = await mountApp({ saved: { entries: [], lastRoot: null } });
  expect(await openPalette(empty)).toMatchInlineSnapshot(`
    [
      "Add repository",
      "Toggle sidebar",
      "Open Settings",
      "Open Appearance settings",
      "Open General settings",
    ]
  `);
});

it("palette titles with a commit selected", async () => {
  const app = await mountApp();
  expect(selectedRow()).toBe("Topic work, Pin Author, 6666666");
  expect(await openPalette(app)).toMatchInlineSnapshot(`
    [
      "Undo Delete branch gone",
      "Fetch",
      "Merge upstream…",
      "Push to origin/main",
      "Search history",
      "Compare with working copy",
      "Pick for comparison",
      "Create tag…",
      "Add repository",
      "Toggle sidebar",
      "Toggle commit inspector",
      "Open Settings",
      "Open Appearance settings",
      "Open General settings",
      "pin (Repository)",
      "other (Repository)",
      "feature (Branch)",
      "main (Branch)",
      "old (Branch)",
      "topic (Branch)",
      "origin/main (Branch)",
      "v1 (Tag)",
      "WIP on main: 4444444 Main tip (Stash)",
    ]
  `);
});

it("palette titles with a worktree that has staged and unstaged entries", async () => {
  const app = await mountApp();
  await app.click(historyRow("Uncommitted changes in pin,"));
  expect(await openPalette(app)).toMatchInlineSnapshot(`
    [
      "Stage all",
      "Unstage all",
      "Discard all changes…",
      "Stash changes…",
      "Commit…",
      "Undo Delete branch gone",
      "Fetch",
      "Merge upstream…",
      "Push to origin/main",
      "Search history",
      "Add repository",
      "Toggle sidebar",
      "Toggle commit inspector",
      "Open Settings",
      "Open Appearance settings",
      "Open General settings",
      "pin (Repository)",
      "other (Repository)",
      "feature (Branch)",
      "main (Branch)",
      "old (Branch)",
      "topic (Branch)",
      "origin/main (Branch)",
      "v1 (Tag)",
      "WIP on main: 4444444 Main tip (Stash)",
    ]
  `);
});

it("palette titles while a write runs", async () => {
  const app = await mountApp();
  await app.click(historyRow("Uncommitted changes in pin,"));
  const write = app.bridge.hold("write", PIN);
  await app.click(get("button", "Stage all"));
  await write.arrived;
  expect(await openPalette(app)).toMatchInlineSnapshot(`
    [
      "Fetch",
      "Search history",
      "Add repository",
      "Toggle sidebar",
      "Toggle commit inspector",
      "Open Settings",
      "Open Appearance settings",
      "Open General settings",
      "Push [disabled]",
      "pin (Repository)",
      "other (Repository)",
      "feature (Branch)",
      "main (Branch)",
      "old (Branch)",
      "topic (Branch)",
      "origin/main (Branch)",
      "v1 (Tag)",
      "WIP on main: 4444444 Main tip (Stash)",
    ]
  `);
  await app.press("Escape");
  write.release();
  await app.settle();
});

it("palette titles while the active worktree merges", async () => {
  const app = await mountApp({
    world: (world) =>
      world.merges.set(PIN_FEATURE, activeMerge(PIN_FEATURE, ["feature.txt"])),
  });
  await app.click(historyRow("Uncommitted changes in pin-feature,"));
  expect(await openPalette(app)).toMatchInlineSnapshot(`
    [
      "Unstage all",
      "Fetch",
      "Push to origin/main",
      "Search history",
      "Add repository",
      "Toggle sidebar",
      "Toggle commit inspector",
      "Open Settings",
      "Open Appearance settings",
      "Open General settings",
      "pin (Repository)",
      "other (Repository)",
      "feature (Branch)",
      "main (Branch)",
      "old (Branch)",
      "topic (Branch)",
      "origin/main (Branch)",
      "v1 (Tag)",
      "WIP on main: 4444444 Main tip (Stash)",
    ]
  `);
});

it("palette titles with a file open, and none on the settings screen", async () => {
  const app = await mountApp();
  get("grid", "Commits").focus();
  await app.press("Enter");
  expect(get("region", "Changes to notes.txt")).toBeTruthy();
  expect(await openPalette(app)).toMatchInlineSnapshot(`
    [
      "Undo Delete branch gone",
      "Fetch",
      "Merge upstream…",
      "Push to origin/main",
      "Back to history",
      "Show unified diff",
      "Show split diff",
      "Show file history",
      "Show blame",
      "Compare with working copy",
      "Pick for comparison",
      "Create tag…",
      "Add repository",
      "Toggle sidebar",
      "Toggle commit inspector",
      "Open Settings",
      "Open Appearance settings",
      "Open General settings",
      "pin (Repository)",
      "other (Repository)",
      "feature (Branch)",
      "main (Branch)",
      "old (Branch)",
      "topic (Branch)",
      "origin/main (Branch)",
      "v1 (Tag)",
      "WIP on main: 4444444 Main tip (Stash)",
    ]
  `);
  await app.press("Escape");
  await app.click(get("button", "Settings"));
  await openPalette(app);
  expect(dialogs(), "the settings dialog blocks the palette").toEqual([
    "Settings",
  ]);
});

it("opening a repository from the palette focuses the history grid once it loads", async () => {
  const app = await mountApp();
  const snapshot = app.bridge.hold("snapshot", OTHER);
  await app.runPaletteItem("other");
  await snapshot.arrived;
  await app.flushFrames();
  expect(focused(), "the fallback while History is gone").toBe(
    "button Toggle sidebar",
  );
  snapshot.release();
  await app.settle();
  expect(focused()).toBe("grid Commits");
  expect(selectedRow()).toBe("Other tip, Pin Author, 8888888");
});

it("opening a repository from the palette leaves focus alone once the pointer moved it", async () => {
  const app = await mountApp();
  const snapshot = app.bridge.hold("snapshot", OTHER);
  await app.runPaletteItem("other");
  await snapshot.arrived;
  await app.flushFrames();
  await app.act(() => {
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  });
  snapshot.release();
  await app.settle();
  expect(focused()).toBe("button Toggle sidebar");
});

it("jumping to a branch in another repository selects it from the settled snapshot, not the cached one", async () => {
  const app = await mountApp();
  await app.click(repositoryRow(OTHER));
  await app.click(repositoryRow(PIN));
  expect(
    get("button", "Collapse other"),
    "opening other expanded it",
  ).toBeTruthy();
  const fresh = oidSchema.parse("b".repeat(40));
  const cached = app.bridge.world.snapshots.get(OTHER)!;
  app.bridge.world.snapshots.set(
    OTHER,
    snapshotSchema.parse({
      ...cached,
      branches: [
        ...cached.branches,
        {
          kind: "local",
          reference: "refs/heads/fresh",
          name: "fresh",
          oid: fresh,
          upstream: null,
        },
      ],
      commits: [
        {
          oid: fresh,
          parents: [OTHER_TIP],
          subject: "Fresh work",
          author: "Pin Author",
          email: "pin@example.com",
          timestamp: 1_700_000_009,
        },
        ...cached.commits,
      ],
    }),
  );
  await app.refocusWindow();
  const reread = app.bridge.hold("snapshot", OTHER);
  await app.click(refRow("refs/heads/fresh", OTHER)!);
  await reread.arrived;
  expect(selectedRow(), "the cached snapshot predates the branch").toBe(
    "Other tip, Pin Author, 8888888",
  );
  reread.release();
  await app.settle();
  expect(selectedRow()).toBe("Fresh work, Pin Author, bbbbbbb");
});

it("showing a stash in another repository selects it once listed", async () => {
  const app = await mountApp();
  await app.click(get("button", "Expand other"));
  await app.click(refRow("stash@{0}", OTHER)!);
  expect(inspectorTitle()).toBe("WIP on trunk: 8888888 Other tip");
  expect(refRow("stash@{0}", OTHER)?.getAttribute("aria-current")).toBe("true");
});

it("a pending stash is dropped when the root changes first", async () => {
  const app = await mountApp();
  await app.click(get("button", "Expand other"));
  const snapshot = app.bridge.hold("snapshot", OTHER);
  await app.click(refRow("stash@{0}", OTHER)!);
  await snapshot.arrived;
  await app.click(repositoryRow(PIN));
  snapshot.release();
  await app.settle();
  await app.click(repositoryRow(OTHER));
  expect(inspectorTitle()).toBe("Other tip");
});

it("Commit… opens the inspector and focuses the summary", async () => {
  const app = await mountApp();
  await app.click(historyRow("Uncommitted changes in pin,"));
  await app.click(get("button", "Toggle commit inspector"));
  expect(query("complementary", "Commit inspector")).toBeNull();
  await app.runPaletteItem("Commit…");
  expect(query("complementary", "Commit inspector")).toBeTruthy();
  expect(document.activeElement?.id).toBe(COMMIT_SUMMARY_ID);
});

it("Hide on a hidden jumped branch shows it in the graph", async () => {
  const app = await mountApp();
  await app.click(historyRow("Release,"));
  await app.click(get("button", "Hide topic"));
  await app.click(refRow("refs/heads/topic")!);
  expect(get("status", /topic is hidden in the graph/)).toBeTruthy();
  await app.runPaletteItem("Show topic");
  expect(query("status", /topic is hidden in the graph/)).toBeNull();
  expect(selectedRow()).toBe("Topic work, Pin Author, 6666666");
  expect(get("button", "Hide topic"), "the branch is shown again").toBeTruthy();
  expect(focused()).toBe("grid Commits");
});

it("Stage all and Discard all act on the selected worktree's lists", async () => {
  const app = await mountApp();
  await app.click(historyRow("Uncommitted changes in pin,"));
  app.bridge.reset();
  await app.runPaletteItem("Stage all");
  const paths = (op: string) =>
    app.bridge.log
      .filter((request) => request.op === "write")
      .map((request) => {
        const operation = request.operation as {
          kind: string;
          entries: { path: string }[];
        };
        return `${operation.kind} ${operation.entries.map((entry) => entry.path).join(",")}`;
      })
      .filter((line) => line.startsWith(op));
  expect(paths("stageFiles")).toEqual(["stageFiles notes.txt"]);
  await app.runPaletteItem("Discard all changes…");
  expect(dialogs()).toEqual(["Discard changes to notes.txt?"]);
  await app.click(get("button", "Discard changes"));
  expect(paths("discard")).toEqual(["discard notes.txt"]);
});

it("closing the palette returns focus to the element focused before it opened", async () => {
  const app = await mountApp();
  const row = refRow("refs/heads/main")!;
  row.focus();
  await app.press("p", { ctrlKey: true });
  await app.press("Escape");
  expect(dialogs()).toEqual([]);
  expect(document.activeElement).toBe(row);
});

it("closing the palette falls back to History when that element is gone", async () => {
  const app = await mountApp();
  refRow("stash@{0}")!.focus();
  await app.press("p", { ctrlKey: true });
  const snapshot = app.bridge.world.snapshots.get(PIN)!;
  app.bridge.world.snapshots.set(PIN, { ...snapshot, stashes: [] });
  await app.refocusWindow();
  expect(refRow("stash@{0}")).toBeNull();
  await app.press("Escape");
  expect(focused()).toBe("grid Commits");
});
