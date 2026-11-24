// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import type { PullRequestSummary } from "./domain/pullRequest";
import {
  dialogs,
  focused,
  get,
  historyRow,
  installHarness,
  mountApp,
  paletteTitles,
  query,
  queryAll,
  selectedRow,
} from "./test/appHarness";
import type { Harness } from "./test/appHarness";
import { pullsKey } from "./test/fakeBridge";
import type { Bridge, World } from "./test/fakeBridge";
import { OTHER, PIN } from "./test/fixtures";
import type { RepositoryRoot } from "./domain/repository";

installHarness();

function pull(
  number: number,
  title: string,
  fields: Partial<PullRequestSummary> = {},
): PullRequestSummary {
  return {
    number,
    title,
    state: { kind: "open", draft: false },
    author: "hubot",
    viewerIsAuthor: false,
    head: `branch-${number}`,
    base: "main",
    labels: { items: [], total: 0 },
    comments: 0,
    reviewRequested: false,
    review: null,
    checks: { passed: 2, failed: 0, skipped: 0, running: 0 },
    mergeable: "mergeable",
    additions: 1,
    deletions: 1,
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: `2026-11-01T00:00:${60 - number}Z`,
    ...fields,
  };
}

function onGitHub(world: World, root: RepositoryRoot, repo: string) {
  const overview = world.overviews.get(root)!;
  world.overviews.set(root, { ...overview, github: { owner: "octo", repo } });
}

const list = (...items: PullRequestSummary[]) => ({
  items,
  total: items.length,
});

/** Two repositories, pin and other, with pull requests. */
function world(world: World) {
  onGitHub(world, PIN, "pin");
  onGitHub(world, OTHER, "other");
  const { pulls } = world.host;
  pulls.set(
    pullsKey("octo/pin", "open"),
    list(
      pull(1, "Review a replay", { reviewRequested: true }),
      pull(2, "Filter by author", {
        labels: { items: [{ name: "ui", color: "0075ca" }], total: 1 },
      }),
    ),
  );
  pulls.set(
    pullsKey("octo/other", "open"),
    list(pull(3, "Rotate the keys", { reviewRequested: true, author: "maja" })),
  );
  pulls.set(
    pullsKey("octo/pin", "recentlyMerged"),
    list(
      pull(4, "Undo a replay", {
        state: { kind: "merged", at: "2026-11-02T00:00:00Z" },
      }),
    ),
  );
  pulls.set(pullsKey("octo/other", "recentlyMerged"), list());
  world.host.status = {
    ...world.host.status,
    github: {
      kind: "connected",
      login: "octo",
      api: "https://api.github.com/",
      method: "gh",
      access: "private",
      connectedAt: 1,
    },
  };
}

const mount = (
  more: {
    world?: (world: World) => void;
    bridge?: (bridge: Bridge) => void;
  } = {},
) =>
  mountApp({
    ...more,
    world: (each) => {
      world(each);
      more.world?.(each);
    },
  });

const entry = () => get("button", /^Pull requests/);
async function visit(app: Harness) {
  await app.click(entry());
}
const shown = () => query("region", "Pull requests") !== null;
const titles = () =>
  queryAll("link")
    .filter((link) => link.matches(".pull-row"))
    .map((row) => row.getAttribute("aria-label")?.split(",")[0]);
const scope = () => document.querySelector(".pull-scope")?.textContent;
const filter = (name: string) =>
  get(
    "checkbox",
    new RegExp(`^${name}`),
    get("complementary", "Pull request sidebar"),
  );
const view = (name: string) =>
  get(
    "button",
    new RegExp(`^${name}`),
    get("navigation", "Pull request views"),
  );
const notices = () =>
  [...document.querySelectorAll(".pull-requests .notice")].map(
    (notice) => notice.textContent,
  );
const reads = (bridge: Bridge) =>
  bridge.hostLog.flatMap(({ op, repository, list }) =>
    op === "pullRequests"
      ? [`${(repository as { repo: string }).repo} ${String(list)}`]
      : [],
  );

it("reads nothing before the first visit, then the first repository alone", async () => {
  const held: ReturnType<Bridge["hold"]>[] = [];
  const app = await mount({
    bridge: (bridge) => {
      held.push(bridge.hold("pullRequests", "octo/pin"));
    },
  });
  expect(app.bridge.hostLog).toEqual([{ op: "status" }]);
  expect(entry().getAttribute("aria-label")).toBe("Pull requests");

  await visit(app);
  expect(reads(app.bridge)).toEqual(["pin open"]);
  expect(scope()).toBe("Reading 2 repositories…");
  expect(focused(), "nothing to focus yet").toBe("region Pull requests");

  held[0]!.release();
  await app.settle();
  expect(reads(app.bridge)).toEqual(["pin open", "other open"]);
  expect(titles()).toEqual([
    "Review a replay",
    "Filter by author",
    "Rotate the keys",
  ]);
  expect(scope()).toBe("3 pull requests across 2 repositories");
});

it("shows each repository's rows as they arrive", async () => {
  const held: ReturnType<Bridge["hold"]>[] = [];
  const app = await mount({
    bridge: (bridge) => {
      held.push(bridge.hold("pullRequests", "octo/other"));
    },
  });
  await visit(app);
  expect(titles()).toEqual(["Review a replay", "Filter by author"]);
  held[0]!.release();
  await app.settle();
  expect(titles()).toHaveLength(3);
});

it("links each row to its pull request on GitHub", async () => {
  const app = await mount();
  await visit(app);
  const row = get("link", /^Rotate the keys/);
  expect(row.getAttribute("href")).toBe("https://github.com/octo/other/pull/3");
  expect(row.getAttribute("target")).toBe("_blank");
  expect(row.getAttribute("aria-label")).toBe(
    "Rotate the keys, #3 in other, by maja, Ready to merge, Your review, checks 2/2",
  );
});

it("keeps the repository screen as it was, and gives focus back on Escape", async () => {
  const app = await mount();
  await app.click(historyRow("Release,"));
  const selected = selectedRow();
  expect(selected).not.toBeNull();
  await visit(app);
  expect(shown()).toBe(true);
  expect(query("grid", "Commits"), "the history is hidden").toBeNull();
  expect(query("button", "Toggle commit inspector")).toBeNull();
  expect(query("navigation", "Repositories and branches")).toBeNull();
  expect(selectedRow(), "and still there").toBe(selected);

  const left = await app.press("Escape", { target: document.body });
  expect(left.defaultPrevented).toBe(true);
  expect(shown()).toBe(false);
  expect(get("grid", "Commits")).toBeTruthy();
  expect(selectedRow()).toBe(selected);
  expect(focused()).toBe("button Pull requests, 2 need your review");
});

it("goes back with the widened button, and to the toggle while the sidebar is hidden", async () => {
  const app = await mount();
  await visit(app);
  await app.click(get("button", /^Back to history/));
  expect(shown()).toBe(false);
  expect(focused()).toBe("button Pull requests, 2 need your review");

  await visit(app);
  await app.click(get("button", "Toggle sidebar"));
  await app.press("Escape", { target: document.body });
  expect(shown()).toBe(false);
  expect(focused()).toBe("button Toggle sidebar");
});

it("searches with Ctrl+F, and Escape clears the search before it leaves", async () => {
  const app = await mount();
  await visit(app);
  const find = await app.press("f", { ctrlKey: true, target: document.body });
  expect(find.defaultPrevented).toBe(true);
  expect(focused()).toBe("textbox Search pull requests");
  const search = get("textbox", "Search pull requests");
  await app.type(search, "#3");
  expect(titles()).toEqual(["Rotate the keys"]);
  expect(scope()).toBe("1 of 3 pull requests across 2 repositories");

  await app.press("Escape", { target: search });
  expect(shown(), "cleared").toBe(true);
  expect(titles()).toHaveLength(3);
  await app.press("Escape", { target: search });
  expect(shown()).toBe(false);
});

it("leaves Escape to an open menu and to Settings", async () => {
  const app = await mount();
  await visit(app);
  await app.click(get("button", /^Sort/));
  await app.press("Escape", { target: get("menuitemradio", "Newest first") });
  expect(query("menu", "Sort")).toBeNull();
  expect(shown()).toBe(true);

  await app.click(get("button", "Settings"));
  expect(dialogs()).toEqual(["Settings"]);
  await app.press("Escape", { target: get("button", "Close settings") });
  expect(dialogs()).toEqual([]);
  expect(shown(), "Settings returns to where it was opened").toBe(true);
});

it("is reached and left through the palette, with every repository action off", async () => {
  const app = await mount();
  await app.runPaletteItem("Show pull requests");
  expect(shown()).toBe(true);
  await app.press("p", { ctrlKey: true, target: document.body });
  expect(paletteTitles()).toEqual([
    "Back to history",
    "Search pull requests",
    "Toggle sidebar",
    "Open Settings",
    "Open General settings",
    "Open Appearance settings",
    "Open Hosts settings",
  ]);
  await app.press("Escape");
  const add = await app.press("o", { ctrlKey: true, target: document.body });
  expect(add.defaultPrevented).toBe(false);
  expect(dialogs()).toEqual([]);
  await app.runPaletteItem("Open Settings");
  await app.runPaletteItem("Back to pull requests");
  await app.runPaletteItem("Back to history");
  expect(shown()).toBe(false);
  expect(focused()).toBe("button Pull requests, 2 need your review");
});

it("steps through the rows with the arrows, J and K, from one Tab stop", async () => {
  const app = await mount();
  await visit(app);
  await app.press("Escape", { target: document.body });
  await visit(app);
  expect(focused()).toMatch(/^link Review a replay/);
  await app.press("j");
  expect(focused()).toMatch(/^link Filter by author/);
  await app.press("ArrowDown");
  expect(focused()).toMatch(/^link Rotate the keys/);
  await app.press("k");
  expect(focused()).toMatch(/^link Filter by author/);
  expect(queryAll("link").map((row) => row.tabIndex)).toEqual([-1, 0, -1]);
});

it("offers the sign-in while no host is connected, and reads once it is", async () => {
  const app = await mount({
    world: (world) => {
      world.host.status = {
        ...world.host.status,
        github: {
          kind: "notConnected",
          ended: { login: "octo", reason: "revoked" },
        },
      };
    },
  });
  await visit(app);
  const region = get("region", "Pull requests");
  expect(region.textContent).toContain(
    "GitHub no longer accepts L1 Git's sign-in for @octo.",
  );
  expect(region.textContent).toContain("Connect a host to see pull requests");
  expect(focused()).toBe("button Sign in to GitHub");
  expect(query("textbox", "Search pull requests")).toBeNull();

  await app.click(get("button", "Sign in to GitHub"));
  expect(dialogs()).toEqual(["Settings"]);
  expect(get("region", "Hosts")).toBeTruthy();
  await app.click(
    get("button", "Sign in to GitHub", get("dialog", "Settings")),
  );
  await app.click(get("button", "Sign in as @octo"));
  expect(reads(app.bridge)).toEqual(["pin open", "other open"]);
  await app.click(get("button", "Close settings"));
  expect(titles()).toHaveLength(3);

  await app.click(get("button", "Settings"));
  await app.click(get("button", "Disconnect"));
  await app.click(
    get("button", "Disconnect", get("dialog", "Disconnect GitHub?")),
  );
  await app.click(get("button", "Close settings"));
  expect(titles(), "nothing of the last sign-in stays").toEqual([]);
  await app.press("Escape", { target: document.body });
  expect(entry().getAttribute("aria-label")).toBe("Pull requests");
});

it("flashes nothing until Rust has said whether a host is connected", async () => {
  const app = await mount({
    bridge: (bridge) => {
      bridge.hold("status");
    },
  });
  await visit(app);
  expect(get("region", "Pull requests").textContent).toBe("All open");
});

it("keeps the sidebar's count true after the first visit", async () => {
  const app = await mount();
  await visit(app);
  await app.press("Escape", { target: document.body });
  expect(entry().querySelector(".pull-badge")?.textContent).toBe("2");

  app.bridge.world.host.pulls.set(pullsKey("octo/pin", "open"), list());
  const now = vi.spyOn(Date, "now");
  const at = Date.now();
  now.mockReturnValue(at + 59_000);
  await app.refocusWindow();
  expect(reads(app.bridge), "not again within a minute").toHaveLength(2);
  now.mockReturnValue(at + 61_000);
  await app.refocusWindow();
  now.mockRestore();
  expect(reads(app.bridge).slice(2)).toEqual(["pin open", "other open"]);
  expect(entry().getAttribute("aria-label")).toBe(
    "Pull requests, 1 needs your review",
  );
});

it("refreshes on the fetch interval while the window is visible, and on the button", async () => {
  const timers = vi.spyOn(window, "setInterval");
  const app = await mount();
  const tick = () =>
    app.act(() => {
      for (const [run, ms] of timers.mock.calls)
        if (ms === 15 * 60_000 && typeof run === "function") run();
    });
  await tick();
  expect(reads(app.bridge), "not before the first visit").toEqual([]);
  await visit(app);
  await tick();
  expect(reads(app.bridge)).toHaveLength(4);
  const visibility = vi
    .spyOn(document, "visibilityState", "get")
    .mockReturnValue("hidden");
  await tick();
  visibility.mockRestore();
  expect(reads(app.bridge)).toHaveLength(4);
  await app.click(get("button", "Refresh pull requests"));
  expect(reads(app.bridge)).toHaveLength(6);
  timers.mockRestore();
});

it("reads the merged ones when that view opens, and while it is the current one", async () => {
  const app = await mount();
  await visit(app);
  await app.click(view("Recently merged"));
  expect(reads(app.bridge).slice(2)).toEqual([
    "pin recentlyMerged",
    "other recentlyMerged",
  ]);
  expect(titles()).toEqual(["Undo a replay"]);
  expect(scope()).toBe("1 merged in the last 7 days");
  expect(get("button", /^Sort/).textContent).toBe("SortRecently merged");
  await app.click(get("button", "Refresh pull requests"));
  expect(reads(app.bridge).slice(4)).toEqual([
    "pin recentlyMerged",
    "other recentlyMerged",
    "pin open",
    "other open",
  ]);
  await app.click(view("All open"));
  expect(reads(app.bridge), "leaving it reads nothing").toHaveLength(8);
  await app.click(get("button", "Refresh pull requests"));
  expect(reads(app.bridge).slice(8)).toEqual(["pin open", "other open"]);
});

it("names the repository GitHub won't show, and where to authorize", async () => {
  const app = await mount();
  const url = "https://github.com/orgs/octo/sso";
  const answer = app.bridge.failHost(
    { kind: "ssoRequired", message: "Authorize L1 Git's sign-in.", url },
    "octo/other",
  );
  await visit(app);
  expect(titles()).toEqual(["Review a replay", "Filter by author"]);
  expect(notices()).toEqual([
    "Couldn't read other. Authorize L1 Git's sign-in.Authorize on GitHub",
  ]);
  expect(get("link", "Authorize on GitHub").getAttribute("href")).toBe(url);
  expect(filter("other").textContent).toBe("otherNo access");

  answer();
  await app.click(get("button", "Refresh pull requests"));
  expect(notices()).toEqual([]);
  expect(titles()).toHaveLength(3);
});

it("keeps the rows while offline, says since when, and tries again", async () => {
  const app = await mount();
  await visit(app);
  const online = app.bridge.failHost({
    kind: "unreachable",
    message: "L1 Git could not reach GitHub.",
  });
  await app.click(get("button", "Refresh pull requests"));
  expect(titles()).toHaveLength(3);
  expect(notices()).toHaveLength(1);
  expect(notices()[0]).toMatch(
    /^Offline\. Showing pull requests as of .+, just now\.Try again$/,
  );
  expect(scope()).toMatch(/^3 pull requests across 2 repositories, as of /);

  online();
  await app.click(get("button", "Try again"));
  expect(notices()).toEqual([]);
});

it("says the hourly limit once, and waits for it in the background", async () => {
  const app = await mount();
  await visit(app);
  app.bridge.failHost({
    kind: "rateLimited",
    message: "GitHub's rate limit for your account is used up.",
    resetAt: Math.ceil(Date.now() / 1_000) + 600,
  });
  await app.click(get("button", "Refresh pull requests"));
  expect(notices()).toEqual([
    "GitHub's rate limit for your account is used up.Try again",
  ]);
  const asked = reads(app.bridge).length;
  const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000);
  await app.refocusWindow();
  now.mockRestore();
  expect(reads(app.bridge)).toHaveLength(asked);
});

it("asks a locked keychain once", async () => {
  const app = await mount();
  app.bridge.failHost({
    kind: "keychain",
    problem: "locked",
    message: "The system keychain is locked.",
  });
  await visit(app);
  expect(reads(app.bridge)).toEqual(["pin open"]);
  expect(notices()).toEqual(["The system keychain is locked.Try again"]);
});

it("leaves a locked keychain alone until the user comes back or tries again", async () => {
  const timers = vi.spyOn(window, "setInterval");
  const app = await mount();
  app.bridge.failHost({
    kind: "keychain",
    problem: "locked",
    message: "The system keychain is locked.",
  });
  await visit(app);
  const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000);
  await app.refocusWindow();
  await app.act(() => {
    for (const [run, ms] of timers.mock.calls)
      if (ms === 15 * 60_000 && typeof run === "function") run();
  });
  expect(reads(app.bridge)).toEqual(["pin open"]);
  await app.click(get("button", /^Back to history/));
  await app.refocusWindow();
  expect(reads(app.bridge), "not from the history either").toHaveLength(1);
  await visit(app);
  expect(reads(app.bridge)).toHaveLength(2);
  await app.click(get("button", "Try again"));
  expect(reads(app.bridge)).toHaveLength(3);
  now.mockRestore();
  timers.mockRestore();
});

it("keeps focus in the list when a refresh takes the focused row away", async () => {
  const app = await mount();
  await visit(app);
  await app.act(() => get("link", /^Review a replay/).focus());
  app.bridge.world.host.pulls.set(
    pullsKey("octo/pin", "open"),
    list(pull(2, "Filter by author")),
  );
  const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000);
  await app.refocusWindow();
  now.mockRestore();
  expect(titles()).not.toContain("Review a replay");
  expect(document.activeElement?.matches("a.pull-row")).toBe(true);
});

it("narrows by repository, label, review and author, and clears it all", async () => {
  const app = await mount();
  await visit(app);
  await app.click(filter("pin"));
  expect(titles()).toEqual(["Rotate the keys"]);
  expect(view("All open").textContent).toBe("All open1");
  expect(filter("pin").getAttribute("aria-checked")).toBe("false");
  await app.click(filter("pin"));

  await app.click(filter("ui"));
  expect(titles()).toEqual(["Filter by author"]);
  await app.click(get("button", /^Author/));
  await app.click(get("menuitemradio", "maja"));
  expect(titles()).toEqual([]);
  expect(get("region", "Pull requests").textContent).toContain("No matches");
  await app.click(get("button", "Clear filters"));
  expect(titles()).toHaveLength(3);
  expect(focused()).toMatch(/^link Review a replay/);

  await app.click(view("Needs your review"));
  expect(scope()).toBe("2 pull requests waiting on you");
  expect(get("region", "Pull requests").textContent).toContain(
    "That's everything waiting on you.",
  );
  await app.click(get("button", /^Sort/));
  await app.click(get("menuitemcheckbox", "Group by repository"));
  expect(queryAll("region", /^(pin|other)$/)).toHaveLength(2);
});

it("says what it leaves out", async () => {
  const app = await mount({
    world: (world) => {
      const { github: _, ...overview } = world.overviews.get(OTHER)!;
      world.overviews.set(OTHER, { ...overview, github: null });
      world.host.pulls.set(pullsKey("octo/pin", "open"), {
        items: [pull(1, "Review a replay")],
        total: 133,
      });
    },
  });
  await visit(app);
  const notes = [...document.querySelectorAll(".pull-note")].map(
    (note) => note.textContent,
  );
  expect(notes).toEqual([
    "Newest 1 of 133 in pin",
    "1 saved repository isn't on GitHub.",
  ]);
});

it("says when nothing is open, and when no saved repository is on GitHub", async () => {
  const empty = await mount({
    world: (world) => {
      for (const name of ["octo/pin", "octo/other"])
        world.host.pulls.set(pullsKey(name, "open"), list());
    },
  });
  await visit(empty);
  expect(get("region", "Pull requests").textContent).toContain(
    "Nothing openNo pull request is open in 2 repositories.",
  );
  await empty.press("Escape", { target: document.body });
  expect(entry().querySelector(".pull-badge"), "no badge for 0").toBeNull();

  const app = await mount({
    world: (world) => {
      for (const root of [PIN, OTHER])
        world.overviews.set(root, {
          ...world.overviews.get(root)!,
          github: null,
        });
    },
  });
  await visit(app);
  expect(get("region", "Pull requests").textContent).toContain(
    "No saved repository is on GitHub",
  );
  expect(reads(app.bridge)).toEqual([]);
});

it("reads only a repository that opens after the visit", async () => {
  const held: ReturnType<Bridge["hold"]>[] = [];
  const app = await mount({
    bridge: (bridge) => {
      held.push(bridge.hold("overview", OTHER));
    },
  });
  await visit(app);
  expect(reads(app.bridge)).toEqual(["pin open"]);
  held[0]!.release();
  await app.settle();
  expect(reads(app.bridge)).toEqual(["pin open", "other open"]);
  expect(titles()).toHaveLength(3);
});
