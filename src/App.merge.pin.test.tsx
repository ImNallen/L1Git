// @vitest-environment happy-dom
import { expect, it } from "vitest";
import {
  dialogs,
  dirtyResolution,
  get,
  historyRow,
  installHarness,
  mountApp,
  openFirstFile,
  query,
  queryAll,
  refRow,
  repositoryRow,
  selectedRow,
} from "./test/appHarness";
import {
  activeMerge,
  applied,
  history,
  OTHER,
  PIN,
  PIN_FEATURE,
  STAMP,
} from "./test/fixtures";
import type { World } from "./test/fakeBridge";

installHarness();

const featureHistory = (world: World) =>
  world.histories.set(
    PIN_FEATURE,
    history(
      applied(PIN_FEATURE, {
        kind: "commit",
        message: "Feature commit",
        staged: STAMP,
      }),
    ),
  );

const PIN_UNDO = "Undo Delete branch gone";
const FEATURE_UNDO = "Undo Commit “Feature commit”";

const targetReads = (app: Awaited<ReturnType<typeof mountApp>>) =>
  app.bridge.lines(
    (request) => request.op === "mergeState" || request.op === "undoHistory",
  );

it("a selected linked worktree becomes the merge and undo target, a commit selection keeps it, a repository switch resets it", async () => {
  const app = await mountApp({ world: featureHistory });
  expect(get("button", PIN_UNDO)).toBeTruthy();
  app.bridge.reset();
  await app.click(historyRow("Uncommitted changes in pin-feature,"));
  expect(targetReads(app)).toEqual([
    "mergeState /fixture/pin-feature",
    "undoHistory /fixture/pin-feature",
  ]);
  expect(get("button", FEATURE_UNDO)).toBeTruthy();

  await app.click(historyRow("Release,"));
  expect(
    get("button", FEATURE_UNDO),
    "a commit selection keeps it",
  ).toBeTruthy();

  await app.click(repositoryRow(OTHER));
  await app.click(repositoryRow(PIN));
  expect(selectedRow()).toBe("Release, Pin Author, 3333333");
  expect(get("button", PIN_UNDO), "a repository switch resets it").toBeTruthy();
});

it("returning with the worktree selection restored makes it the target again", async () => {
  const app = await mountApp({ world: featureHistory });
  await app.click(historyRow("Uncommitted changes in pin-feature,"));
  await app.click(repositoryRow(OTHER));
  expect(query("button", FEATURE_UNDO)).toBeNull();
  await app.click(repositoryRow(PIN));
  expect(selectedRow()).toBe("Uncommitted changes in pin-feature, 1 modified");
  expect(
    get("button", FEATURE_UNDO),
    "the reset on the switch runs before the restored selection sets the target",
  ).toBeTruthy();
});

it("the merge review closes when the active worktree changes", async () => {
  const app = await mountApp();
  await app.click(historyRow("Uncommitted changes in pin-feature,"));
  await app.click(get("button", "Merge upstream…"));
  expect(dialogs()).toEqual(["Merge upstream"]);
  expect(
    new Set(app.bridge.lines((request) => request.op === "mergeReview")),
    "the review reads the active worktree",
  ).toEqual(new Set(["mergeReview /fixture/pin-feature"]));
  const snapshot = app.bridge.world.snapshots.get(PIN)!;
  app.bridge.world.snapshots.set(PIN, {
    ...snapshot,
    worktrees: snapshot.worktrees.filter(
      (worktree) => worktree.root !== PIN_FEATURE,
    ),
  });
  app.bridge.reset();
  await app.refocusWindow();
  expect(dialogs()).toEqual([]);
  expect(app.bridge.lines((request) => request.op === "mergeReview")).toEqual(
    [],
  );
});

it("stageFiles is refused while a resolution draft is unmarkable", async () => {
  const app = await mountApp();
  await dirtyResolution(app, PIN, "notes.txt");
  await app.click(historyRow("Uncommitted changes in pin,"));
  app.bridge.reset();
  await app.click(get("button", "Stage all"));
  await app.runPaletteItem("Stage all");
  expect(app.bridge.count("write")).toBe(0);
  await app.runPaletteItem("Unstage all");
  expect(app.bridge.lines((request) => request.op === "write")).toEqual([
    "write /fixture/pin unstageFiles",
  ]);
});

it("merge-forbidden writes are refused on the active worktree; owned paths go through", async () => {
  const app = await mountApp({
    world: (world) =>
      world.merges.set(
        PIN_FEATURE,
        activeMerge(PIN_FEATURE, ["elsewhere.txt"]),
      ),
  });
  await app.click(historyRow("Uncommitted changes in pin-feature,"));
  app.bridge.reset();
  await app.runPaletteItem("Unstage all");
  expect(app.bridge.count("write"), "outside the merge footprint").toBe(0);
  app.bridge.world.merges.set(
    PIN_FEATURE,
    activeMerge(PIN_FEATURE, ["feature.txt"]),
  );
  await app.refocusWindow();
  await app.runPaletteItem("Unstage all");
  expect(app.bridge.lines((request) => request.op === "write")).toEqual([
    "write /fixture/pin-feature unstageFiles",
  ]);
});

const hunkButtons = () =>
  queryAll("button").filter((button) =>
    button.closest('[role="group"][aria-label^="Hunk "]'),
  );
const disabled = () =>
  hunkButtons().map((button) => button.getAttribute("aria-disabled"));

it("partial staging is disabled during a merge on the open file's root", async () => {
  const app = await mountApp();
  await app.click(historyRow("Uncommitted changes in pin,"));
  await openFirstFile(app);
  expect(hunkButtons().length).toBeGreaterThan(0);
  expect(disabled()).toEqual(hunkButtons().map(() => "false"));
  app.bridge.world.merges.set(PIN, activeMerge(PIN, ["notes.txt"]));
  await app.refocusWindow();
  expect(get("region", "Changes to notes.txt")).toBeTruthy();
  expect(disabled()).toEqual(hunkButtons().map(() => "true"));
});

it("partial staging stays enabled during a linked worktree's merge (pins current behavior: the open file's root is the repository root)", async () => {
  const app = await mountApp();
  await app.click(historyRow("Uncommitted changes in pin-feature,"));
  await openFirstFile(app);
  app.bridge.world.merges.set(
    PIN_FEATURE,
    activeMerge(PIN_FEATURE, ["feature.txt"]),
  );
  await app.refocusWindow();
  expect(query("button", "Stash…"), "the worktree is merging").toBeNull();
  expect(get("region", "Changes to feature.txt")).toBeTruthy();
  expect(hunkButtons().length).toBeGreaterThan(0);
  expect(disabled()).toEqual(hunkButtons().map(() => "false"));
});

it("the inspector hides Stash and Commit while the active worktree merges", async () => {
  const app = await mountApp();
  await app.click(historyRow("Uncommitted changes in pin-feature,"));
  expect(get("button", "Stash…")).toBeTruthy();
  expect(get("group", "Commit")).toBeTruthy();
  app.bridge.world.merges.set(
    PIN_FEATURE,
    activeMerge(PIN_FEATURE, ["feature.txt"]),
  );
  await app.refocusWindow();
  expect(query("button", "Stash…")).toBeNull();
  expect(query("group", "Commit")).toBeNull();
});

it("Inspect in the merge panel selects the worktree, opens the inspector, and clears the sidebar jump", async () => {
  const app = await mountApp({
    world: (world) =>
      world.merges.set(PIN_FEATURE, activeMerge(PIN_FEATURE, ["feature.txt"])),
  });
  await app.click(historyRow("Uncommitted changes in pin-feature,"));
  await app.click(get("button", "Hide topic"));
  await app.click(historyRow("Release,"));
  await app.click(get("button", "Toggle commit inspector"));
  expect(query("complementary", "Commit inspector")).toBeNull();
  await app.click(refRow("refs/heads/topic")!);
  expect(get("status", /topic is hidden in the graph/)).toBeTruthy();
  await app.click(get("button", "Review staged result and conflicts"));
  expect(selectedRow()).toBe("Uncommitted changes in pin-feature, 1 modified");
  expect(query("complementary", "Commit inspector")).toBeTruthy();
  expect(query("status", /topic is hidden in the graph/)).toBeNull();
});

it("the branch menu pins the selected source to the active linked destination without checkout", async () => {
  const app = await mountApp();
  await app.click(historyRow("Uncommitted changes in pin-feature,"));
  app.bridge.reset();
  await app.click(get("button", /^origin/));
  await app.contextMenu(refRow("refs/remotes/origin/main")!);
  await app.click(get("menuitem", "Merge into current branch…"));
  expect(dialogs()).toEqual(["Merge into current branch"]);
  expect(document.querySelector(".merge-pair")?.textContent).toContain(
    "refs/remotes/origin/main",
  );
  expect(document.querySelector(".merge-pair")?.textContent).toContain(
    "refs/heads/feature",
  );
  expect([
    ...new Map(
      app.bridge.log
        .filter((request) => request.op === "mergeReview")
        .map((request) => [JSON.stringify(request), request]),
    ).values(),
  ]).toEqual([
    {
      op: "mergeReview",
      path: PIN_FEATURE,
      selection: { kind: "branch", reference: "refs/remotes/origin/main" },
    },
  ]);
  expect(app.bridge.count("write")).toBe(0);
  expect(app.bridge.count("merge")).toBe(0);
  expect(selectedRow()).toBe("Uncommitted changes in pin-feature, 1 modified");
});

it("the palette merges its selected branch into the active destination", async () => {
  const app = await mountApp();
  await app.click(historyRow("Uncommitted changes in pin-feature,"));
  await app.click(refRow("refs/heads/topic")!);
  app.bridge.reset();
  await app.runPaletteItem("Merge selected branch into current branch…");
  expect(dialogs()).toEqual(["Merge into current branch"]);
  expect([
    ...new Map(
      app.bridge.log
        .filter((request) => request.op === "mergeReview")
        .map((request) => [JSON.stringify(request), request]),
    ).values(),
  ]).toEqual([
    {
      op: "mergeReview",
      path: PIN_FEATURE,
      selection: { kind: "branch", reference: "refs/heads/topic" },
    },
  ]);
  expect(app.bridge.count("write")).toBe(0);
});

it("a late merge review response cannot reopen or retarget a review after switching repositories", async () => {
  const app = await mountApp();
  const pending = app.bridge.hold("mergeReview", PIN);
  await app.contextMenu(refRow("refs/heads/topic")!);
  await app.click(get("menuitem", "Merge into current branch…"));
  await pending.arrived;
  expect(dialogs()).toEqual(["Merge into current branch"]);
  await app.click(repositoryRow(OTHER));
  expect(dialogs()).toEqual([]);
  pending.release();
  await app.settle();
  expect(dialogs()).toEqual([]);
  expect(app.bridge.count("mergeReview", OTHER)).toBe(0);
  expect(app.bridge.count("merge")).toBe(0);
});
