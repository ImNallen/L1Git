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
  paletteTitles,
  query,
  queryAll,
  refRow,
  selectedRow,
} from "./test/appHarness";
import { history, PIN, PIN_FEATURE, replayInProgress } from "./test/fixtures";
import type { Applied } from "./domain/repository";

installHarness();

const PANEL = "Cherry-pick or revert";

it("a cherry-pick started in a terminal opens the panel on the next refocus", async () => {
  const app = await mountApp();
  expect(query("region", PANEL)).toBeNull();
  app.bridge.world.merges.set(PIN, replayInProgress(PIN, ["notes.txt"]));
  await app.refocusWindow();
  expect(get("region", PANEL).textContent).toContain("Cherry-pick in progress");
  expect(query("region", "Branch merge")).toBeNull();
});

it("the panel follows the active worktree", async () => {
  const app = await mountApp({
    world: (world) =>
      world.merges.set(
        PIN_FEATURE,
        replayInProgress(PIN_FEATURE, ["feature.txt"]),
      ),
  });
  expect(query("region", PANEL)).toBeNull();
  await app.click(historyRow("Uncommitted changes in pin-feature,"));
  expect(get("region", PANEL).textContent).toContain("refs/heads/feature");
});

it("Finish writes finishReplay, closes the panel, and lands in Undo with its label", async () => {
  const app = await mountApp({
    world: (world) =>
      world.merges.set(PIN, replayInProgress(PIN, ["notes.txt"])),
  });
  app.bridge.respond("write", (request, world, fallback) => {
    const entry = fallback() as Applied;
    if (request.path === PIN) {
      world.merges.delete(PIN);
      world.histories.set(PIN, history(entry));
    }
    return entry;
  });
  app.bridge.reset();
  await app.click(get("button", "Use suggested message"));
  await app.click(get("button", "Finish cherry-pick"));
  expect(app.bridge.lines((request) => request.op === "write")).toEqual([
    `write ${PIN} finishReplay`,
  ]);
  expect(query("region", PANEL)).toBeNull();
  expect(get("button", "Undo Cherry-pick “Picked commit”")).toBeTruthy();
});

it("a refused Finish shows why through the write notice and keeps the panel", async () => {
  const app = await mountApp({
    world: (world) =>
      world.merges.set(PIN, replayInProgress(PIN, ["notes.txt"])),
  });
  app.bridge.fail("write", {
    kind: "hookFailed",
    message: "pre-commit said no.",
    output: "",
  });
  await app.click(get("button", "Use suggested message"));
  await app.click(get("button", "Finish cherry-pick"));
  expect(
    get("alert", /Could not finish cherry-pick “Picked commit”/).textContent,
  ).toContain("pre-commit said no.");
  expect(get("region", PANEL)).toBeTruthy();
});

it("Abort names the unsaved draft, asks first, and discards only what was shown", async () => {
  const app = await mountApp({
    world: (world) =>
      world.merges.set(
        PIN,
        replayInProgress(PIN, ["notes.txt"], {
          kind: "revert",
          unresolved: ["notes.txt"],
          tree: null,
        }),
      ),
  });
  await dirtyResolution(app, PIN, "notes.txt");
  app.bridge.reset();
  await app.click(get("button", "Abort revert…"));
  expect(dialogs()).toEqual(["Abort this revert?"]);
  expect(get("dialog", "Abort this revert?").textContent).toContain(
    "Also discard these resolution drafts if they have not changed since this confirmation opened: notes.txt.",
  );
  expect(app.bridge.count("replayAbort")).toBe(0);
  await app.click(get("button", "Discard revert and abort"));
  expect(app.bridge.log.filter(({ op }) => op === "replayAbort")).toEqual([
    {
      op: "replayAbort",
      path: PIN,
      of: expect.objectContaining({ kind: "revert" }) as unknown,
      head: expect.objectContaining({
        reference: "refs/heads/main",
      }) as unknown,
    },
  ]);
  expect(
    app.modules.resolutionDrafts.resolutionOf(
      app.modules.resolutionDrafts.resolutionKey(PIN, "notes.txt"),
    ),
  ).toBeNull();
  expect(get("region", PANEL).textContent).toContain("Revert aborted.");
  expect(query("button", "Finish revert")).toBeNull();
});

it("Review in the panel selects the worktree and opens the inspector", async () => {
  const app = await mountApp({
    world: (world) =>
      world.merges.set(
        PIN_FEATURE,
        replayInProgress(PIN_FEATURE, ["feature.txt"]),
      ),
  });
  await app.click(historyRow("Uncommitted changes in pin-feature,"));
  await app.click(historyRow("Release,"));
  await app.click(get("button", "Toggle commit inspector"));
  expect(query("complementary", "Commit inspector")).toBeNull();
  await app.click(get("button", "Review staged result and conflicts"));
  expect(selectedRow()).toBe("Uncommitted changes in pin-feature, 1 modified");
  expect(query("complementary", "Commit inspector")).toBeTruthy();
});

it("the palette offers no write a replay forbids (actions.ts)", async () => {
  const app = await mountApp();
  await app.click(historyRow("Uncommitted changes in pin,"));
  await app.click(refRow("refs/heads/topic")!);
  const gated = [
    "Discard all changes…",
    "Stash changes…",
    "Commit…",
    "Merge selected branch into current branch…",
    "Merge upstream…",
    "Check out topic",
    "New branch from topic…",
    "Rename topic…",
    "Delete topic…",
  ];
  const offered = async () => {
    await app.press("p", { ctrlKey: true });
    const titles = paletteTitles();
    await app.press("Escape");
    return gated.filter((title) => titles.includes(title));
  };
  const idle = await offered();
  expect(idle.length, "these commands are offered while idle").toBeGreaterThan(
    3,
  );
  app.bridge.world.merges.set(PIN, replayInProgress(PIN, ["notes.txt"]));
  await app.refocusWindow();
  expect(await offered()).toEqual([]);
});

it("the inspector hides Stash and Commit during a replay (CommitInspector)", async () => {
  const app = await mountApp();
  await app.click(historyRow("Uncommitted changes in pin-feature,"));
  expect(get("button", "Stash…")).toBeTruthy();
  expect(get("group", "Commit")).toBeTruthy();
  app.bridge.world.merges.set(
    PIN_FEATURE,
    replayInProgress(PIN_FEATURE, ["feature.txt"]),
  );
  await app.refocusWindow();
  expect(query("button", "Stash…")).toBeNull();
  expect(query("group", "Commit")).toBeNull();
});

it("Unstage all goes through only inside the footprint (useStaging)", async () => {
  const app = await mountApp({
    world: (world) =>
      world.merges.set(
        PIN_FEATURE,
        replayInProgress(PIN_FEATURE, ["elsewhere.txt"]),
      ),
  });
  await app.click(historyRow("Uncommitted changes in pin-feature,"));
  app.bridge.reset();
  await app.runPaletteItem("Unstage all");
  expect(app.bridge.count("write"), "outside the footprint").toBe(0);
  app.bridge.world.merges.set(
    PIN_FEATURE,
    replayInProgress(PIN_FEATURE, ["feature.txt"]),
  );
  await app.refocusWindow();
  await app.runPaletteItem("Unstage all");
  expect(app.bridge.lines((request) => request.op === "write")).toEqual([
    `write ${PIN_FEATURE} unstageFiles`,
  ]);
});

it("partial staging is disabled during a replay on the open file's root (useDiffPane)", async () => {
  const hunkButtons = () =>
    queryAll("button").filter((button) =>
      button.closest('[role="group"][aria-label^="Hunk "]'),
    );
  const disabled = () =>
    hunkButtons().map((button) => button.getAttribute("aria-disabled"));
  const app = await mountApp();
  await app.click(historyRow("Uncommitted changes in pin,"));
  await openFirstFile(app);
  expect(hunkButtons().length).toBeGreaterThan(0);
  expect(disabled()).toEqual(hunkButtons().map(() => "false"));
  app.bridge.world.merges.set(PIN, replayInProgress(PIN, ["notes.txt"]));
  await app.refocusWindow();
  expect(disabled()).toEqual(hunkButtons().map(() => "true"));
});
