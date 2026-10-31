// @vitest-environment happy-dom
import { expect, it } from "vitest";
import {
  get,
  historyRow,
  installHarness,
  mountApp,
  query,
} from "./test/appHarness";
import {
  noUpstream,
  OTHER_COMMON_DIR,
  PIN,
  PIN_COMMON_DIR,
} from "./test/fixtures";
import { publishOptionsSchema } from "./domain/push";

installHarness();

const TODAY_SNAPSHOT_READS_AFTER_FOCUS = 2;
const TODAY_SNAPSHOT_READS_AFTER_FILE_WRITE = 1;
const TODAY_SNAPSHOT_READS_AFTER_REF_WRITE = 3;

it("window focus rereads overview, snapshot, statuses, undo history, merge state, and sidebar refs", async () => {
  const app = await mountApp();
  await app.click(get("button", "Expand other"));
  app.bridge.reset();
  await app.refocusWindow();
  expect(app.bridge.lines()).toMatchInlineSnapshot(`
    [
      "overview /fixture/pin local",
      "undoHistory /fixture/pin",
      "mergeState /fixture/pin",
      "snapshot /fixture/pin",
      "refs /fixture/other",
      "worktreeStatus /fixture/pin",
      "worktreeStatus /fixture/pin-feature",
      "mergeState /fixture/pin",
      "snapshot /fixture/pin",
      "preparePush /fixture/pin",
      "worktreeStatus /fixture/pin",
      "worktreeStatus /fixture/pin-feature",
      "undoHistory /fixture/pin",
    ]
  `);
  expect(
    app.bridge.count("snapshot", PIN),
    "pins current behavior: focus rereads the snapshot directly and again through refs-changed",
  ).toBe(TODAY_SNAPSHOT_READS_AFTER_FOCUS);
});

it("a second focus within 1 s and a focus while the document is hidden do nothing", async () => {
  const app = await mountApp();
  await app.refocusWindow();
  app.bridge.reset();
  await app.refocusWindow();
  expect(app.bridge.lines(), "throttled for 1 s").toEqual([]);
  app.dom.clock.offset += 1_000;
  app.dom.setHidden(true);
  await app.act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(app.bridge.lines(), "skipped while hidden").toEqual([]);
  app.dom.setHidden(false);
  await app.act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(app.bridge.count("snapshot", PIN)).toBe(
    TODAY_SNAPSHOT_READS_AFTER_FOCUS,
  );
});

it("refs-changed for the active root rereads all; for another root it does nothing", async () => {
  const app = await mountApp();
  app.bridge.reset();
  await app.act(() =>
    app.modules.overview.overviewStore().refreshLocal(PIN_COMMON_DIR),
  );
  expect(app.bridge.lines()).toMatchInlineSnapshot(`
    [
      "overview /fixture/pin local",
      "undoHistory /fixture/pin",
      "mergeState /fixture/pin",
      "snapshot /fixture/pin",
      "preparePush /fixture/pin",
      "worktreeStatus /fixture/pin",
      "worktreeStatus /fixture/pin-feature",
    ]
  `);
  app.bridge.reset();
  await app.act(() =>
    app.modules.overview.overviewStore().refreshLocal(OTHER_COMMON_DIR),
  );
  expect(app.bridge.lines()).toMatchInlineSnapshot(`
    [
      "overview /fixture/other local",
      "preparePush /fixture/other",
    ]
  `);
  expect(app.bridge.count("snapshot")).toBe(0);
});

it("staging a file ends in write, history and status, refreshLocal, then the full reread", async () => {
  const app = await mountApp();
  await app.click(historyRow("Uncommitted changes in pin,"));
  app.bridge.reset();
  await app.click(get("button", "Stage all"));
  expect(app.bridge.lines()).toMatchInlineSnapshot(`
    [
      "write /fixture/pin stageFiles",
      "undoHistory /fixture/pin",
      "worktreeStatus /fixture/pin",
      "overview /fixture/pin local",
      "undoHistory /fixture/pin",
      "mergeState /fixture/pin",
      "snapshot /fixture/pin",
      "preparePush /fixture/pin",
      "worktreeStatus /fixture/pin",
      "worktreeStatus /fixture/pin-feature",
    ]
  `);
  expect(app.bridge.count("snapshot", PIN)).toBe(
    TODAY_SNAPSHOT_READS_AFTER_FILE_WRITE,
  );
});

it("creating a branch requests the snapshot three times (pins current behavior)", async () => {
  const app = await mountApp();
  await app.contextMenu(historyRow("Release,"));
  await app.click(get("menuitem", "New branch…"));
  await app.type(get("textbox", "Branch name"), "release-fix");
  app.bridge.reset();
  await app.click(get("button", "Create branch"));
  expect(app.bridge.lines()).toMatchInlineSnapshot(`
    [
      "write /fixture/pin createBranch",
      "overview /fixture/pin local",
      "snapshot /fixture/pin",
      "undoHistory /fixture/pin",
      "mergeState /fixture/pin",
      "snapshot /fixture/pin",
      "preparePush /fixture/pin",
      "worktreeStatus /fixture/pin",
      "worktreeStatus /fixture/pin-feature",
      "worktreeStatus /fixture/pin",
      "undoHistory /fixture/pin",
      "overview /fixture/pin local",
      "undoHistory /fixture/pin",
      "mergeState /fixture/pin",
      "snapshot /fixture/pin",
      "preparePush /fixture/pin",
      "worktreeStatus /fixture/pin",
      "worktreeStatus /fixture/pin-feature",
    ]
  `);
  expect(
    app.bridge.count("snapshot", PIN),
    "pins current behavior: reread.refs, then refs-changed from the write's own refreshLocal and from E5",
  ).toBe(TODAY_SNAPSHOT_READS_AFTER_REF_WRITE);
});

it("Try again on a read error runs refreshRepository", async () => {
  const app = await mountApp();
  const restore = app.bridge.fail("snapshot", {
    kind: "timedOut",
    message: "Reading this repository took too long.",
  });
  await app.refocusWindow();
  restore();
  app.bridge.reset();
  await app.click(get("button", "Try again"));
  expect(app.bridge.lines()).toMatchInlineSnapshot(`
    [
      "overview /fixture/pin local",
      "undoHistory /fixture/pin",
      "mergeState /fixture/pin",
      "snapshot /fixture/pin",
      "worktreeStatus /fixture/pin",
      "worktreeStatus /fixture/pin-feature",
      "mergeState /fixture/pin",
      "snapshot /fixture/pin",
      "preparePush /fixture/pin",
      "worktreeStatus /fixture/pin",
      "worktreeStatus /fixture/pin-feature",
      "undoHistory /fixture/pin",
    ]
  `);
  expect(query("button", "Try again")).toBeNull();
});

it("adding a remote in Publish refreshes the overview and rereads the repository", async () => {
  const app = await mountApp({
    world: (world) => world.pushes.set(PIN, noUpstream()),
  });
  const options = publishOptionsSchema.parse({
    kind: "available",
    branch: "refs/heads/main",
    source: "4".repeat(40),
    remotes: [],
  });
  app.bridge.respond("publishOptions", () => options);
  app.bridge.respond("addRemote", (request) => ({
    name: (request.remote as { name: string }).name,
    refresh: { kind: "refreshed", options },
  }));
  await app.click(get("button", "Publish branch…"));
  await app.click(get("button", "Add remote…"));
  await app.type(get("textbox", "Remote name"), "upstream");
  await app.type(
    get("textbox", "URL or filesystem path"),
    "https://example.com/u",
  );
  app.bridge.reset();
  await app.click(get("button", "Add remote"));
  expect(app.bridge.lines()).toMatchInlineSnapshot(`
    [
      "addRemote /fixture/pin",
      "overview /fixture/pin local",
      "snapshot /fixture/pin",
      "undoHistory /fixture/pin",
      "mergeState /fixture/pin",
      "snapshot /fixture/pin",
      "preparePush /fixture/pin",
      "worktreeStatus /fixture/pin",
      "worktreeStatus /fixture/pin-feature",
    ]
  `);
});

it("while a write runs, Push waits for it and push preparation is redone afterwards", async () => {
  const app = await mountApp();
  await app.click(historyRow("Uncommitted changes in pin,"));
  const write = app.bridge.hold("write", PIN);
  await app.click(get("button", "Stage all"));
  await write.arrived;
  const push = get("button", "Push");
  expect(push.getAttribute("title")).toBe(
    "Wait for the current local write to finish.",
  );
  expect((push as HTMLButtonElement).disabled).toBe(true);
  app.bridge.reset();
  write.release();
  await app.settle();
  expect(get("button", "Push to origin/main")).toBeTruthy();
  expect(app.bridge.count("preparePush", PIN)).toBeGreaterThan(0);
});
