// @vitest-environment happy-dom
import { expect, it } from "vitest";
import {
  dialogs,
  dirtyResolution,
  focused,
  get,
  historyRow,
  installHarness,
  mountApp,
  query,
  repositoryRow,
} from "./test/appHarness";
import type { Harness } from "./test/appHarness";
import { C4, noUpstream, OTHER, PIN, pinStatus } from "./test/fixtures";
import { headSchema } from "./domain/repository";
import { publishOptionsSchema } from "./domain/push";

installHarness();

const NARROW_SIDEBAR = "(max-width: 939px)";
const NARROW_INSPECTOR = "(max-width: 1099px)";

function unload() {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

const sidebar = () => query("complementary", "Repository sidebar");
const inspector = () => query("complementary", "Commit inspector");

it("beforeunload is guarded while resolution drafts exist, and not while drafts are frozen", async () => {
  const app = await mountApp();
  expect(unload(), "no unsaved results").toBe(false);
  await dirtyResolution(app, PIN, "notes.txt");
  expect(unload(), "an unsaved result").toBe(true);
  const { draftImpact, freezeDrafts } = app.modules.draftProtection;
  const frozen = freezeDrafts(draftImpact().revision);
  expect(frozen.kind).toBe("frozen");
  expect(unload(), "an update restart froze the drafts").toBe(false);
  if (frozen.kind === "frozen") frozen.release();
  expect(unload()).toBe(true);
});

it("narrow media queries close the sidebar and the inspector", async () => {
  const app = await mountApp();
  expect(sidebar()).toBeTruthy();
  expect(inspector()).toBeTruthy();
  await app.act(() => app.dom.media.set(NARROW_SIDEBAR, true));
  expect(sidebar()).toBeNull();
  expect(get("button", "Toggle sidebar").getAttribute("aria-pressed")).toBe(
    "false",
  );
  expect(inspector()).toBeTruthy();
  await app.act(() => app.dom.media.set(NARROW_INSPECTOR, true));
  expect(inspector()).toBeNull();
  await app.act(() => app.dom.media.set(NARROW_SIDEBAR, false));
  expect(sidebar(), "widening does not reopen it").toBeNull();
});

it("a narrow window starts with the sidebar and the inspector closed", async () => {
  await mountApp({ media: { [NARROW_SIDEBAR]: true }, innerWidth: 1000 });
  expect(sidebar()).toBeNull();
  expect(inspector()).toBeNull();
});

it("leaving settings focuses Settings, or the sidebar toggle when the sidebar is closed", async () => {
  const app = await mountApp();
  get("grid", "Commits").focus();
  await app.click(get("button", "Settings"));
  expect(dialogs()).toEqual(["Settings"]);
  await app.click(get("button", "Close settings"));
  expect(dialogs()).toEqual([]);
  expect(focused()).toBe("button Settings");

  await app.click(get("button", "Toggle sidebar"));
  get("grid", "Commits").focus();
  await app.runPaletteItem("Open Settings");
  expect(dialogs()).toEqual(["Settings"]);
  await app.press("Escape");
  expect(dialogs()).toEqual([]);
  expect(focused()).toBe("button Toggle sidebar");
});

it("the toggle buttons keep focus as they move between the toolbar and the pane", async () => {
  const app = await mountApp();
  const inSidebar = get("button", "Toggle sidebar");
  expect(inSidebar.closest(".sidebar")).not.toBeNull();
  await app.click(inSidebar);
  const inToolbar = get("button", "Toggle sidebar");
  expect(inToolbar.closest(".toolbar")).not.toBeNull();
  expect(document.activeElement).toBe(inToolbar);
  await app.click(inToolbar);
  expect(document.activeElement?.closest(".sidebar")).not.toBeNull();
  expect(focused()).toBe("button Toggle sidebar");

  const inPane = get("button", "Toggle commit inspector");
  expect(inPane.closest(".inspector")).not.toBeNull();
  await app.click(inPane);
  expect(document.activeElement?.closest(".toolbar")).not.toBeNull();
  expect(focused()).toBe("button Toggle commit inspector");
  await app.click(get("button", "Toggle commit inspector"));
  expect(document.activeElement?.closest(".inspector")).not.toBeNull();
  expect(focused()).toBe("button Toggle commit inspector");
});

it("the commit box stays out of the inspector's scrolling content, and the file lists stay in it", async () => {
  const app = await mountApp();
  await app.click(historyRow("Uncommitted changes in pin,"));
  const box = get("group", "Commit");
  expect(box.closest(".inspector")).not.toBeNull();
  expect(box.closest(".inspector-content")).toBeNull();
  expect(
    inspector()?.querySelector(".inspector-content .worktree-groups"),
  ).not.toBeNull();
});

it("the commit button names the branch, and says Amend while amending", async () => {
  const app = await mountApp();
  await app.click(historyRow("Uncommitted changes in pin,"));
  await app.type(get("textbox", "Summary"), "Ship it");
  expect(get("button", "Commit to main").title).toMatch(
    /^Commit to main \((⌘|Ctrl\+)Enter\)$/,
  );
  await app.click(get("checkbox", undefined, get("group", "Commit")));
  expect(get("button", "Amend").title).toMatch(/^Amend \(/);
  expect(query("button", "Commit to main")).toBeNull();
  await app.click(get("checkbox", undefined, get("group", "Commit")));
  expect(get("button", "Commit to main")).toBeTruthy();
});

it("the commit button says Commit on a detached HEAD", async () => {
  const head = headSchema.parse({ kind: "detached", oid: C4 });
  const app = await mountApp({
    world: (world) => {
      const snapshot = world.snapshots.get(PIN)!;
      world.snapshots.set(PIN, {
        ...snapshot,
        head,
        worktrees: snapshot.worktrees.map((worktree) =>
          worktree.current ? { ...worktree, head } : worktree,
        ),
      });
      world.statuses.set(PIN, { ...pinStatus(), head });
    },
  });
  await app.click(historyRow("Uncommitted changes in pin,"));
  expect(get("button", "Commit")).toBeTruthy();
});

it("the commit button names the branch the commit would land on when the snapshot lags behind", async () => {
  const app = await mountApp({
    world: (world) =>
      world.statuses.set(PIN, {
        ...pinStatus(),
        head: headSchema.parse({
          kind: "attached",
          reference: "refs/heads/feature",
          oid: C4,
        }),
      }),
  });
  await app.click(historyRow("Uncommitted changes in pin,"));
  expect(get("button", "Commit to feature")).toBeTruthy();
});

const breadcrumb = () => document.querySelector(".toolbar .breadcrumb");

it("the toolbar shows the checked-out branch after the repository name", async () => {
  await mountApp();
  expect(breadcrumb()?.textContent).toBe("pin/main");
  expect(breadcrumb()?.querySelector("[title='main']")).not.toBeNull();
});

it("the toolbar shows a detached HEAD by its short commit ID", async () => {
  await mountApp({
    world: (world) =>
      world.snapshots.set(PIN, {
        ...world.snapshots.get(PIN)!,
        head: headSchema.parse({ kind: "detached", oid: C4 }),
      }),
  });
  expect(breadcrumb()?.textContent).toBe("pin/Detached at 4444444");
});

it("the toolbar shows no branch until the snapshot arrives", async () => {
  const app = await mountApp();
  const snapshot = app.bridge.hold("snapshot", OTHER);
  await app.click(repositoryRow(OTHER));
  await snapshot.arrived;
  expect(breadcrumb()?.textContent).toBe("other");
  snapshot.release();
  await app.settle();
  expect(breadcrumb()?.textContent).toBe("other/trunk");
});

async function fromHistoryMenu(app: Harness, row: string, item: string) {
  get("button", "Settings").focus();
  await app.contextMenu(historyRow(row));
  await app.click(get("menuitem", item));
}

it("closing Edit message returns focus to History", async () => {
  const app = await mountApp();
  await fromHistoryMenu(app, "Main tip,", "Edit message…");
  expect(dialogs()).toEqual(["Edit message"]);
  await app.click(get("button", "Close edit message"));
  expect(dialogs()).toEqual([]);
  expect(focused()).toBe("grid Commits");
});

it("closing Publish moves focus to History even when it opened from another control", async () => {
  const app = await mountApp({
    world: (world) => world.pushes.set(PIN, noUpstream()),
  });
  app.bridge.respond("publishOptions", () =>
    publishOptionsSchema.parse({ kind: "unavailable", reason: "detached" }),
  );
  get("button", "Settings").focus();
  await app.click(get("button", "Publish branch…"));
  expect(dialogs()).toEqual(["Publish branch"]);
  await app.click(get("button", "Close publish branch"));
  expect(dialogs()).toEqual([]);
  expect(focused()).toBe("grid Commits");
});

it("closing New branch and Create tag returns focus to History", async () => {
  const app = await mountApp();
  await fromHistoryMenu(app, "Release,", "New branch…");
  expect(dialogs()).toEqual(["New branch"]);
  await app.click(get("button", "Cancel"));
  await app.flushFrames();
  expect(dialogs()).toEqual([]);
  expect(focused()).toBe("grid Commits");

  await fromHistoryMenu(app, "Release,", "Create tag…");
  expect(dialogs()).toEqual(["Create tag"]);
  await app.click(get("button", "Close create tag"));
  await app.flushFrames();
  expect(dialogs()).toEqual([]);
  expect(focused()).toBe("grid Commits");
});
