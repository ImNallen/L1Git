// @vitest-environment happy-dom
import { expect, it } from "vitest";
import {
  dialogs,
  get,
  installHarness,
  mountApp,
  paletteTitles,
  query,
  refRow,
  repositoryRow,
} from "./test/appHarness";
import type { Harness } from "./test/appHarness";
import {
  C6,
  OTHER,
  PIN,
  PIN_FEATURE,
  noUpstream,
  pinOverview,
  pinSnapshot,
} from "./test/fixtures";
import type { World } from "./test/fakeBridge";
import { RECENTS_KEY } from "./domain/recents";

installHarness();

const TRIED = "/fixture/.worktrees/pin-topic";

const menuItem = (label: string) => get("menuitem", new RegExp(`^${label}`));

const sidebarRoots = () =>
  [...document.querySelectorAll(".repository-tree .repository-open")].map(
    (row) => row.getAttribute("title"),
  );

const activeRoot = () =>
  document
    .querySelector(".repository-tree .repository-row.active .repository-open")
    ?.getAttribute("title");

const savedLastRoot = () =>
  (
    JSON.parse(localStorage.getItem(RECENTS_KEY) ?? "{}") as {
      lastRoot?: string;
    }
  ).lastRoot;

const writes = (app: Harness) =>
  app.bridge.log.filter((request) =>
    ["worktreeReview", "createWorktree", "removeWorktree"].includes(request.op),
  );

async function tryTopic(app: Harness) {
  await app.contextMenu(refRow("refs/heads/topic")!);
  await app.click(menuItem("Try it locally…"));
}

/** The linked worktree saved in the sidebar and open, as its own repository. */
function featureOpen(world: World) {
  const pin = pinSnapshot();
  world.snapshots.set(PIN_FEATURE, {
    ...pin,
    root: PIN_FEATURE,
    name: "pin-feature",
    head: pin.worktrees[1]!.head,
    worktrees: pin.worktrees.map((worktree) => ({
      ...worktree,
      current: worktree.root === PIN_FEATURE,
    })),
  });
  world.overviews.set(PIN_FEATURE, {
    ...pinOverview(),
    root: PIN_FEATURE,
    name: "pin-feature",
  });
  world.pushes.set(PIN_FEATURE, noUpstream());
}

it("the branch menu offers Try it locally unless a worktree has the branch, and Remove worktree for a linked one", async () => {
  const app = await mountApp();
  await app.contextMenu(refRow("refs/heads/topic")!);
  expect(menuItem("Try it locally…").getAttribute("aria-disabled")).toBe(
    "false",
  );
  expect(query("menuitem", /^Remove worktree/)).toBeNull();
  await app.press("Escape");

  await app.contextMenu(refRow("refs/heads/main")!);
  expect(menuItem("Try it locally…").textContent).toContain("Checked out");
  expect(menuItem("Try it locally…").getAttribute("aria-disabled")).toBe(
    "true",
  );
  expect(query("menuitem", /^Remove worktree/)).toBeNull();
  await app.press("Escape");

  await app.contextMenu(refRow("refs/heads/feature")!);
  expect(menuItem("Try it locally…").textContent).toContain(
    "Checked out in pin-feature",
  );
  expect(menuItem("Remove worktree…").getAttribute("aria-disabled")).toBe(
    "false",
  );
});

it("Remove worktree is dimmed for the worktree that is open", async () => {
  const app = await mountApp({
    world: featureOpen,
    saved: { entries: [PIN, PIN_FEATURE], lastRoot: PIN_FEATURE },
  });
  await app.contextMenu(refRow("refs/heads/feature", PIN_FEATURE)!);
  const remove = menuItem("Remove worktree…");
  expect(remove.getAttribute("aria-disabled")).toBe("true");
  expect(remove.textContent).toContain("Open another worktree");
  await app.click(remove);
  expect(dialogs()).toEqual([]);
  await app.contextMenu(refRow("refs/heads/main", PIN_FEATURE)!);
  expect(query("menuitem", /^Remove worktree/)).toBeNull();
});

it("Try it locally reviews the branch, then creates it at the proposed folder and keeps it in the sidebar without opening it", async () => {
  const app = await mountApp();
  app.bridge.reset();
  await tryTopic(app);

  expect(dialogs()).toEqual(["Try topic locally"]);
  const source = { kind: "local", reference: "refs/heads/topic", oid: C6 };
  expect(
    new Set(writes(app).map((request) => JSON.stringify(request))),
  ).toEqual(
    new Set([JSON.stringify({ op: "worktreeReview", path: PIN, source })]),
  );
  expect((get("textbox", "Folder") as HTMLInputElement).value).toBe(TRIED);
  expect(get("dialog").textContent).toContain("Local branch: topic");

  app.bridge.reset();
  await app.click(get("button", "Create worktree"));

  expect(writes(app)).toEqual([
    { op: "createWorktree", path: PIN, source, folder: TRIED },
  ]);
  expect(dialogs()).toEqual([]);
  expect(sidebarRoots()).toEqual([PIN, OTHER, TRIED]);
  expect(activeRoot()).toBe(PIN);
  expect(savedLastRoot()).toBe(PIN);
  expect(app.bridge.count("snapshot", TRIED)).toBe(0);
  expect(
    get("status", /^Created pin-topic from topic\. It is in the sidebar\./),
  ).toBeTruthy();
  expect(get("button", "Open worktree")).toBeTruthy();
  expect(get("button", "Stay here")).toBeTruthy();
});

it("Open worktree opens the new worktree and Stay here changes nothing else", async () => {
  const app = await mountApp();
  await tryTopic(app);
  await app.click(get("button", "Create worktree"));
  await app.click(get("button", "Stay here"));
  expect(query("button", "Open worktree")).toBeNull();
  expect(activeRoot()).toBe(PIN);
  expect(app.bridge.count("snapshot", TRIED)).toBe(0);

  await app.contextMenu(refRow("refs/heads/old")!);
  await app.click(menuItem("Try it locally…"));
  await app.click(get("button", "Create worktree"));
  await app.click(get("button", "Open worktree"));
  const opened = "/fixture/.worktrees/pin-old";
  expect(app.bridge.count("snapshot", opened)).toBeGreaterThan(0);
  expect(activeRoot()).toBe(opened);
  expect(query("button", "Open worktree")).toBeNull();
});

it("the notice shows only while the repository that made the worktree is open", async () => {
  const app = await mountApp();
  await tryTopic(app);
  await app.click(get("button", "Create worktree"));
  expect(get("button", "Open worktree")).toBeTruthy();
  await app.click(repositoryRow(OTHER));
  expect(activeRoot()).toBe(OTHER);
  expect(query("button", "Open worktree")).toBeNull();
});

it("a refused create shows under the fields and keeps the dialog open with the edited folder", async () => {
  const app = await mountApp({
    bridge: (bridge) =>
      bridge.fail("createWorktree", {
        kind: "unsupportedPath",
        message:
          "This folder already exists and is not empty. Choose another location.",
      }),
  });
  await tryTopic(app);
  await app.type(get("textbox", "Folder"), "~/busy");
  await app.click(get("button", "Create worktree"));

  expect(dialogs()).toEqual(["Try topic locally"]);
  expect(get("alert").textContent).toContain("is not empty");
  expect((get("textbox", "Folder") as HTMLInputElement).value).toBe("~/busy");
  expect(writes(app).at(-1)).toMatchObject({
    op: "createWorktree",
    folder: "~/busy",
  });
  expect(query("button", "Open worktree")).toBeNull();
  expect(sidebarRoots()).toEqual([PIN, OTHER]);
});

it("a refused review shows in the dialog and Create worktree stays disabled", async () => {
  const app = await mountApp();
  await app.click(get("button", /^origin/));
  await app.contextMenu(refRow("refs/remotes/origin/main")!);
  await app.click(menuItem("Try it locally…"));

  expect(dialogs()).toEqual(["Try origin/main locally"]);
  expect(get("alert").textContent).toContain(
    "main is checked out in /fixture/pin",
  );
  const create = get("button", "Create worktree");
  expect(create.getAttribute("aria-disabled")).toBe("true");
  await app.click(create);
  expect(app.bridge.count("createWorktree")).toBe(0);
});

it("a worktree whose post-checkout hook failed is still saved, and the notice shows the hook's output", async () => {
  const app = await mountApp({
    bridge: (bridge) =>
      bridge.respond("createWorktree", (_request, _world, fallback) => ({
        ...(fallback() as object),
        trouble: {
          kind: "afterHookFailed",
          message:
            "Git made the worktree pin-topic, but the post-checkout hook failed. Remove worktree takes it away.",
          output: "npm ERR! missing script: prepare\n",
        },
      })),
  });
  await tryTopic(app);
  await app.click(get("button", "Create worktree"));

  const notice = get(
    "status",
    /^Created pin-topic from topic\. It is in the sidebar\./,
  );
  expect(notice.textContent).toContain("post-checkout hook failed");
  expect(notice.textContent).toContain("npm ERR! missing script: prepare");
  expect(sidebarRoots()).toEqual([PIN, OTHER, TRIED]);
});

it("Remove worktree asks first, removes the linked worktree, drops it from the sidebar, and rereads the history", async () => {
  const app = await mountApp({
    world: featureOpen,
    saved: { entries: [PIN, PIN_FEATURE, OTHER], lastRoot: PIN },
  });
  await app.contextMenu(refRow("refs/heads/feature")!);
  await app.click(menuItem("Remove worktree…"));
  expect(dialogs()).toEqual(["Remove worktree pin-feature?"]);
  expect(get("dialog").textContent).toContain("feature and its commits stay");
  app.bridge.reset();

  await app.click(get("button", "Remove worktree"));

  expect(writes(app)).toEqual([
    { op: "removeWorktree", path: PIN, worktree: PIN_FEATURE },
  ]);
  expect(app.bridge.count("snapshot", PIN)).toBeGreaterThan(0);
  expect(app.bridge.count("undoHistory", PIN)).toBeGreaterThan(0);
  expect(sidebarRoots()).toEqual([PIN, OTHER]);
  await app.contextMenu(refRow("refs/heads/feature")!);
  expect(menuItem("Try it locally…").getAttribute("aria-disabled")).toBe(
    "false",
  );
  expect(query("menuitem", /^Remove worktree/)).toBeNull();
});

it("a refused remove shows in a notice and the sidebar keeps the worktree", async () => {
  const app = await mountApp({
    world: featureOpen,
    saved: { entries: [PIN, PIN_FEATURE, OTHER], lastRoot: PIN },
    bridge: (bridge) =>
      bridge.fail("removeWorktree", {
        kind: "conflict",
        message:
          "pin-feature has uncommitted or untracked files. Commit, stash, or discard them there, then remove the worktree.",
      }),
  });
  await app.contextMenu(refRow("refs/heads/feature")!);
  await app.click(menuItem("Remove worktree…"));
  await app.click(get("button", "Remove worktree"));

  expect(get("alert").textContent).toBe(
    "Could not remove the worktree. pin-feature has uncommitted or untracked files. Commit, stash, or discard them there, then remove the worktree.",
  );
  expect(sidebarRoots()).toEqual([PIN, PIN_FEATURE, OTHER]);
  await app.click(get("button", "Dismiss"));
  expect(query("alert")).toBeNull();
});

it("the palette offers Try it locally and Remove worktree for the sidebar branch only when each can run", async () => {
  const app = await mountApp();
  await app.click(refRow("refs/heads/topic")!);
  await app.press("p", { ctrlKey: true, target: document.body });
  expect(paletteTitles()).toContain("Try topic locally…");
  expect(
    paletteTitles().some((title) => title.startsWith("Remove worktree")),
  ).toBe(false);
  await app.press("Escape");

  await app.click(refRow("refs/heads/feature")!);
  await app.press("p", { ctrlKey: true, target: document.body });
  expect(paletteTitles()).toContain("Remove worktree pin-feature…");
  expect(paletteTitles()).not.toContain("Try feature locally…");
  await app.press("Escape");

  await app.click(refRow("refs/heads/topic")!);
  await app.runPaletteItem("Try topic locally…");
  expect(dialogs()).toEqual(["Try topic locally"]);
});
