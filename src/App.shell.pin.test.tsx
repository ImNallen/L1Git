import { toolbarItem } from "./test/appHarness";
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
  refRow,
  repositoryRow,
} from "./test/appHarness";
import type { Harness } from "./test/appHarness";
import {
  C4,
  C5,
  noUpstream,
  OTHER,
  PIN,
  pinOverview,
  pinStatus,
} from "./test/fixtures";
import { overviewSchema } from "./domain/overview";
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

it("unreadable line statistics stay unknown without background polling", async () => {
  const app = await mountApp();
  await app.act(() => new Promise((resolve) => setTimeout(resolve, 250)));
  const reads = app.bridge.count("lineStats", PIN);
  expect(reads).toBeGreaterThan(0);
  await app.act(() => new Promise((resolve) => setTimeout(resolve, 350)));
  expect(app.bridge.count("lineStats", PIN)).toBe(reads);
});

it("repository search reveals matching tags and stashes without changing collapsed sections", async () => {
  const app = await mountApp();
  const filter = get("textbox", "Filter repositories and refs");
  expect(refRow("refs/tags/v1")?.closest("[inert]") ?? true).toBeTruthy();
  await app.type(filter, "v1");
  expect(refRow("refs/tags/v1")?.closest("[inert]")).toBeNull();
  await app.type(filter, "WIP on main");
  expect(query("button", /stash@\{0\}/)).not.toBeNull();
  await app.type(filter, "");
  expect(refRow("refs/tags/v1")?.closest("[inert]") ?? true).toBeTruthy();
});

it.each(["Escape", "clear button"])(
  "closing an unmatched repository search with %s restores the active repository and focus",
  async (close) => {
    const app = await mountApp();
    const filter = get("textbox", "Filter repositories and refs");
    await app.type(filter, "no-such-repository-or-branch");
    expect(query("button", "pin")).toBeNull();
    filter.focus();
    if (close === "Escape") await app.press("Escape", { target: filter });
    else await app.click(get("button", "Close repository search"));
    expect(document.activeElement).toBe(repositoryRow(PIN));
    expect(filter).toHaveProperty("value", "");
  },
);

it("selecting a branch in another repository preserves keyboard focus", async () => {
  const app = await mountApp();
  await app.click(repositoryRow(OTHER));
  const row = refRow("refs/heads/trunk", OTHER);
  if (!row) throw new Error("Missing other repository branch");
  row.focus();
  await app.click(row);
  expect(row.isConnected).toBe(true);
  expect(document.activeElement).toBe(row);
  await app.press("ArrowUp");
  expect(document.activeElement).not.toBe(document.body);
  expect(document.activeElement).not.toBe(row);
});

it("Fetch fetches the selected branch, else the checked-out one, and Fetch all every remote", async () => {
  const app = await mountApp();
  const fetches = () =>
    app.bridge
      .lines()
      .filter(
        (line) => line.startsWith("overview ") && !line.endsWith(" local"),
      );
  app.bridge.reset();
  await app.click(await toolbarItem(app, "Fetch", "Fetch"));
  await app.click(await toolbarItem(app, "Fetch", "Fetch all"));
  await app.click(get("button", /^origin/));
  await app.click(refRow("refs/remotes/origin/main")!);
  await app.click(await toolbarItem(app, "Fetch", "Fetch"));
  expect(fetches()).toEqual([
    "overview /fixture/pin refs/heads/main",
    "overview /fixture/pin remote",
    "overview /fixture/pin refs/remotes/origin/main",
  ]);

  await app.click(refRow("refs/heads/topic")!);
  const unavailable = await toolbarItem(app, "Fetch", "Fetch");
  expect(unavailable.getAttribute("aria-disabled")).toBe("true");
  expect(unavailable.getAttribute("title")).toBe(
    "topic has no upstream on a remote, so there is nothing to fetch for it. Use Fetch all.",
  );
});

it("a toolbar menu supports keyboard navigation past unavailable actions and returns focus", async () => {
  const app = await mountApp();
  await app.click(refRow("refs/heads/topic")!);
  await app.click(get("button", "Fetch"));
  const first = document.querySelector('[role="menuitem"]');
  expect(first?.getAttribute("aria-disabled")).toBe("true");
  expect(document.activeElement).toBe(first);
  if (!(first instanceof HTMLElement)) throw new Error("Missing menu action");
  await app.click(first);
  expect(dialogs()).toEqual([]);
  await app.press("End");
  expect(document.activeElement?.textContent).toBe("Fetch all");
  await app.press("Escape");
  expect(query("menu", "Repository actions")).toBeNull();
  expect(focused()).toBe("button Fetch");
});

it("Pull fetches the checked-out branch, then reviews a merge or refuses one when diverged", async () => {
  const app = await mountApp();
  app.bridge.reset();
  await app.click(await toolbarItem(app, "Pull", "Pull (Fast-forward only)"));
  expect(app.bridge.lines((request) => request.op === "overview").at(0)).toBe(
    "overview /fixture/pin refs/heads/main",
  );
  expect(get("alert", /Did not fast-forward main/).textContent).toBe(
    "Did not fast-forward main. It has diverged from its upstream. Use Pull (Fast-forward if possible) to merge instead.",
  );
  expect(dialogs()).toEqual([]);

  await app.click(
    await toolbarItem(app, "Pull", "Pull (Fast-forward if possible)"),
  );
  expect(dialogs()).toEqual(["Merge upstream"]);
  expect(app.bridge.count("fastForward", PIN)).toBe(0);
});

it("Pull (Rebase) rebases a diverged branch as a write and reports a stop", async () => {
  const app = await mountApp();
  app.bridge.reset();
  await app.click(await toolbarItem(app, "Pull", "Pull (Rebase)"));
  expect(
    app.bridge.log
      .filter((request) => request.op === "write")
      .map(({ operation, expect }) => ({ operation, expect })),
  ).toEqual([
    {
      operation: {
        kind: "rebase",
        branch: "refs/heads/main",
        onto: "refs/remotes/origin/main",
      },
      expect: {
        head: { kind: "attached", reference: "refs/heads/main", oid: C4 },
      },
    },
  ]);

  const message =
    "The rebase stopped on conflicts in notes.txt, so L1 Git aborted it and nothing changed. Use Pull (Fast-forward if possible) to merge instead.";
  app.bridge.fail("write", { kind: "conflict", message });
  await app.click(await toolbarItem(app, "Pull", "Pull (Rebase)"));
  expect(get("alert", /Could not rebase/).textContent).toBe(
    `Could not rebase main onto origin/main. ${message}`,
  );
});

it("Pull fast-forwards a branch that is behind its upstream", async () => {
  const app = await mountApp();
  const behind = overviewSchema.parse({
    ...pinOverview(),
    branches: pinOverview().branches.map((branch) =>
      branch.name === "main"
        ? {
            ...branch,
            state: {
              kind: "behind",
              upstream: "refs/remotes/origin/main",
              target: C5,
              behind: 1,
              blocker: null,
            },
          }
        : branch,
    ),
  });
  app.bridge.respond("overview", () => behind);
  app.bridge.respond("fastForward", () => ({
    outcomes: [
      { kind: "advanced", reference: "refs/heads/main", from: C4, to: C5 },
    ],
    overview: pinOverview(),
  }));
  await app.click(
    await toolbarItem(app, "Pull", "Pull (Fast-forward if possible)"),
  );
  expect(
    app.bridge.log
      .filter((request) => request.op === "fastForward")
      .map((request) => request.advances),
  ).toEqual([[{ reference: "refs/heads/main", from: C4, to: C5 }]]);
  expect(dialogs()).toEqual([]);
});

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

  await app.runPaletteItem("Toggle sidebar");
  get("grid", "Commits").focus();
  await app.runPaletteItem("Open Settings");
  expect(dialogs()).toEqual(["Settings"]);
  await app.press("Escape");
  expect(dialogs()).toEqual([]);
  expect(focused()).toBe("button Toggle sidebar");
});

it("the sidebar toggle stays put and keeps focus while the sidebar opens and closes", async () => {
  const app = await mountApp();
  const toggle = get("button", "Toggle sidebar");
  expect(toggle.getAttribute("aria-pressed")).toBe("true");
  expect(toggle.closest(".toolbar, .sidebar")).toBeNull();
  await app.click(toggle);
  expect(get("button", "Toggle sidebar")).toBe(toggle);
  expect(toggle.getAttribute("aria-pressed")).toBe("false");
  expect(document.activeElement).toBe(toggle);
  await app.click(toggle);
  expect(get("button", "Toggle sidebar")).toBe(toggle);
  expect(toggle.getAttribute("aria-pressed")).toBe("true");
  expect(document.activeElement).toBe(toggle);
  await app.runPaletteItem("Toggle sidebar");
  expect(toggle.getAttribute("aria-pressed")).toBe("false");
  expect(document.activeElement).toBe(toggle);
});

it("the inspector toggle keeps focus as it moves between the toolbar and the pane", async () => {
  const app = await mountApp();
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

it("names the repository history while keeping its toolbar search visible", async () => {
  await mountApp();
  expect(document.querySelector(".history-heading")?.textContent).toBe(
    "pin commits",
  );
  expect(document.querySelector(".repository-toggle")).toBeNull();
  expect(document.querySelector(".repositories-heading strong")).toBeNull();
  expect(
    document.querySelector(
      ".toolbar input[aria-label='Search loaded history']",
    ),
  ).not.toBeNull();
});

it("keeps repository identity while detached", async () => {
  await mountApp({
    world: (world) =>
      world.snapshots.set(PIN, {
        ...world.snapshots.get(PIN)!,
        head: headSchema.parse({ kind: "detached", oid: C4 }),
      }),
  });
  expect(
    document.querySelector(".repository-open[aria-current='true']")
      ?.textContent,
  ).toBe("pin");
});

it("updates the selected repository without hiding its refs on repeat clicks", async () => {
  const app = await mountApp();
  await app.click(repositoryRow(OTHER));
  await app.settle();
  expect(
    document.querySelector(".repository-open[aria-current='true']")
      ?.textContent,
  ).toBe("other");
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
  await app.click(await toolbarItem(app, "Push", "Publish branch…"));
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
