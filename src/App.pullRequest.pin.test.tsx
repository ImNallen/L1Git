// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import {
  focused,
  get,
  installHarness,
  paletteTitles,
  query,
  queryAll,
} from "./test/appHarness";
import type { Harness } from "./test/appHarness";
import { pullKey, pullsKey } from "./test/fakeBridge";
import type { Bridge, World } from "./test/fakeBridge";
import {
  at,
  link,
  open,
  page,
  pull,
  refresh,
  row,
  tab,
  visit,
} from "./test/pullRequests";

installHarness();

const detail = () => query("article", /^Row/);
const said = () => document.querySelector(".conversation")?.textContent ?? null;
/** What it says once each text had its turn. */
async function read(app: Harness) {
  for (let frame = 0; frame < 5; frame += 1) await app.flushFrames();
  return said();
}
const chosen = () =>
  queryAll("tab")
    .filter((each) => each.getAttribute("aria-selected") === "true")
    .map((each) => each.textContent);
const notices = () =>
  [...document.querySelectorAll(".pull-detail .notice")].map(
    (notice) => notice.textContent,
  );
const box = () => document.querySelector(".merge-box")?.textContent;
const reads = (bridge: Bridge) =>
  bridge.hostLog.flatMap(({ op, number }) =>
    op === "pullRequest" ? [Number(number)] : [],
  );
/** Drafts are on this computer, so reading them asks GitHub nothing. */
const asksOfGitHub = (bridge: Bridge) =>
  bridge.hostLog.filter(({ op }) => op !== "drafts");

it("opens a row in the app, and shows it whole", async () => {
  const app = await visit();
  expect(reads(app.bridge), "not before it opens").toEqual([]);
  await open(app, 1);
  expect(reads(app.bridge)).toEqual([1]);
  expect(focused()).toBe("heading Row 1 #1");
  expect(link, "the list is hidden").toThrow();
  expect(query("textbox", "Search pull requests")).toBeNull();
  expect(await read(app)).toMatch(
    /^Mmaja opened this pull request .*Reads once\./,
  );
  expect(said()).toContain("maja added 1 commit");
  expect(said()).toContain("sara commented");
  expect(queryAll("tab").map(({ textContent }) => textContent)).toEqual([
    "Conversation1",
    "Commits1",
    "Files changed2",
    "Checks0",
  ]);
  expect(document.querySelector(".pull-position")?.textContent).toBe("1 of 4");
  expect(get("link", "Open on GitHub").getAttribute("href")).toBe(
    "https://github.com/octo/pin/pull/1",
  );
  const inspector = get("complementary", "Pull request details");
  expect(inspector.textContent).toContain("Nobody yet");
  expect(inspector.textContent).toContain("+1 −1 in 2 files");
  expect(box()).toBe(
    "Ready to mergeGitHub finds nothing that stops it.Squash and merge",
  );
});

it("leaves a click with a modifier to the browser", async () => {
  await visit();
  const prevented = (init: MouseEventInit) => {
    const click = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      ...init,
    });
    let before = false;
    window.addEventListener(
      "click",
      () => {
        before = click.defaultPrevented;
        click.preventDefault();
      },
      { once: true },
    );
    link(1).dispatchEvent(click);
    return before;
  };
  expect(prevented({ metaKey: true })).toBe(false);
  expect(prevented({ ctrlKey: true })).toBe(false);
  expect(prevented({ shiftKey: true })).toBe(false);
  expect(detail()).toBeNull();
});

it("shows what the list knows while it reads, and says that it does", async () => {
  const held: ReturnType<Bridge["hold"]>[] = [];
  const app = await visit({
    bridge: (bridge) => {
      held.push(bridge.hold("pullRequest", "octo/pin"));
    },
  });
  await open(app, 1);
  expect(get("heading", "Row 1 #1")).toBeTruthy();
  expect(document.querySelector(".pull-detail-meta")?.textContent).toMatch(
    /^Openmaja wants to merge intomainfrombranch-1/,
  );
  expect(tab("Commits").textContent).toBe("Commits–");
  expect(said()).toBeNull();
  const status = () => queryAll("status").map(({ textContent }) => textContent);
  expect(status()).toContain("Loading pull request…");
  held[0]!.release();
  await app.settle();
  expect(said()).not.toBeNull();
  expect(status()).not.toContain("Loading pull request…");
});

it("goes back to its row with the button, and steps back with Escape", async () => {
  const app = await visit();
  await open(app, 2);
  await app.click(get("button", "Pull requests"));
  expect(detail()).toBeNull();
  expect(focused()).toMatch(/^link Row 2,/);

  await open(app, 2);
  const focus = vi.spyOn(HTMLElement.prototype, "focus");
  await app.press("Escape");
  expect(focus.mock.calls.at(-1)).toEqual([{ preventScroll: true }]);
  focus.mockRestore();
  expect(detail()).toBeNull();
  expect(focused()).toMatch(/^link Row 2,/);
  await app.press("Escape");
  expect(query("region", "Pull requests")).toBeNull();
});

it("goes back to the neighbor of a row that is gone", async () => {
  const app = await visit();
  await open(app, 2);
  app.bridge.world.host.pulls.set(
    pullsKey("octo/pin", "open"),
    page([row(1), row(5)]),
  );
  await app.click(refresh());
  expect(detail()).not.toBeNull();
  expect(document.querySelector(".pull-position"), "in no list").toBeNull();
  await app.click(get("button", "Pull requests"));
  expect(focused()).toMatch(/^link Row 3,/);
});

it("leaves Escape to the palette and to Settings, and offers the way back", async () => {
  const app = await visit();
  await open(app, 1);
  await app.press("p", { ctrlKey: true, target: document.body });
  expect(paletteTitles()).toEqual([
    "Back to pull requests",
    "Toggle sidebar",
    "Toggle pull request details",
    "Open Settings",
    "Open General settings",
    "Open Appearance settings",
    "Open Hosts settings",
  ]);
  await app.press("Escape");
  expect(detail()).not.toBeNull();
  await app.click(get("button", "Settings"));
  await app.press("Escape", { target: get("button", "Close settings") });
  expect(detail()).not.toBeNull();
  await app.runPaletteItem("Back to pull requests");
  expect(detail()).toBeNull();
  expect(focused()).toMatch(/^link Row 1,/);
});

it("stays open over a visit to the history", async () => {
  const app = await visit();
  await open(app, 1);
  const back = get("button", "Back to history");
  expect(back.querySelector("kbd"), "Escape leads elsewhere").toBeNull();
  await app.click(back);
  await app.click(get("button", /^Pull requests/));
  expect(focused()).toBe("heading Row 1 #1");
  expect(reads(app.bridge)).toEqual([1, 1]);
});

it("steps through the tabs with the arrows, and starts each pull request anew", async () => {
  const app = await visit();
  await open(app, 1);
  await app.act(() => tab("Conversation").focus());
  await app.press("ArrowRight");
  expect(chosen()).toEqual(["Commits1"]);
  expect(focused()).toBe("tab Commits1");
  expect(get("tabpanel", "Commits1").textContent).toContain("Read it");
  await app.press("End");
  expect(chosen()).toEqual(["Checks0"]);
  expect(get("tabpanel", "Checks0").textContent).toBe("No checks.");
  await app.press("ArrowRight");
  expect(chosen()).toEqual(["Conversation1"]);
  await app.press("ArrowLeft");
  expect(queryAll("tab").map((each) => each.tabIndex)).toEqual([-1, -1, -1, 0]);
  await app.click(refresh());
  expect(chosen(), "a refresh keeps it").toEqual(["Checks0"]);

  await app.click(get("button", "Pull requests"));
  await open(app, 2);
  expect(chosen()).toEqual(["Conversation1"]);
  expect(said()).toContain("No description.");
});

it("keeps the sidebar's filters, and closes for a view", async () => {
  const app = await visit();
  await open(app, 1);
  await app.click(get("checkbox", /^other/));
  expect(detail()).not.toBeNull();
  expect(document.querySelector(".pull-position")?.textContent).toBe("1 of 3");
  await app.click(get("button", /^Drafts/));
  expect(detail()).toBeNull();
});

it("toggles its inspector, whose width and state the commit inspector shares", async () => {
  const app = await visit();
  expect(query("button", "Toggle pull request details")).toBeNull();
  await open(app, 1);
  await app.click(get("button", "Toggle pull request details"));
  expect(query("complementary", "Pull request details")).toBeNull();
  expect(focused()).toBe("button Toggle pull request details");
  await app.click(get("button", "Back to history"));
  expect(query("complementary", "Commit inspector")).toBeNull();
  await app.click(get("button", "Toggle commit inspector"));
  await app.click(get("button", /^Pull requests/));
  expect(get("separator", "Resize pull request details")).toBeTruthy();
});

const check = (
  name: string,
  state: "passed" | "failed" | "running",
  url: string | null = null,
) => ({
  name,
  state,
  required: false,
  startedAt: null,
  completedAt: null,
  url,
});

it("shows the worst checks first, and the rest on their tab", async () => {
  const app = await visit({
    world: ({ host }) =>
      host.details.set(
        pullKey("octo/pin", 1),
        pull(1, {
          mergeState: "unstable",
          checks: page([
            check("a", "passed"),
            check("b", "passed"),
            check("c", "passed"),
            check("d", "running", "http://plain.test/"),
            check("e", "failed", "https://ci.test/e"),
          ]),
        }),
      ),
  });
  await open(app, 1);
  const names = [
    ...get("region", "Checks").querySelectorAll(".pull-inspector-name"),
  ].map(({ textContent }) => textContent);
  expect(names).toEqual(["e", "d", "a", "b"]);
  await app.click(get("button", "Show 1 more"));
  expect(focused()).toBe("tab Checks5");
  const panel = get("tabpanel", "Checks5");
  expect(panel.textContent).toMatch(
    /^1 failing, 1 running, 3 passed on 1111111/,
  );
  expect(queryAll("link", /^Open [a-e]$/, panel)).toHaveLength(1);
});

it("folds a resolved thread, and shows the hunk of another as text when it is no hunk", async () => {
  const thread = {
    review: null,
    line: 3,
    startLine: null,
    originalLine: 3,
    originalStartLine: null,
    side: "right" as const,
    outdated: true,
    hunk: "no hunk",
    can: { reply: true, resolve: true, unresolve: false },
    comments: page([{ id: "TC1", body: "Fixed", by: "sara", at: at(3) }]),
  };
  const app = await visit({
    world: ({ host }) =>
      host.details.set(
        pullKey("octo/pin", 1),
        pull(1, {
          threads: page([
            { ...thread, id: "T1", path: "a.ts", resolved: true },
            { ...thread, id: "T2", path: "b.ts", resolved: false },
          ]),
        }),
      ),
  });
  await open(app, 1);
  const folded = get("region", "Thread on a.ts");
  expect(folded.textContent).toBe("a.tsLine 3OutdatedResolved1 commentShow");
  await app.click(get("button", /^Resolved/, folded));
  await read(app);
  expect(folded.textContent).toContain("Fixed");
  expect(
    get("region", "Thread on b.ts").querySelector("pre")?.textContent,
  ).toBe("no hunk");
});

it("says when a large one came without its threads", async () => {
  const app = await visit({
    world: ({ host }) =>
      host.details.set(
        pullKey("octo/pin", 1),
        pull(1, { threads: null, timeline: page([], 300) }),
      ),
  });
  await open(app, 1);
  expect(said()).toContain("Earlier activity isn't shown.");
  expect(said()).toContain(
    "Review threads didn't load. GitHub couldn't answer for a pull request this large.",
  );
  expect(tab("Conversation").textContent).toBe("Conversation0+");
});

it("says why it could not read, tries again, and keeps focus", async () => {
  const app = await visit();
  const online = app.bridge.failHost(
    { kind: "gitHubFailed", httpStatus: 502, message: "GitHub failed." },
    pullKey("octo/pin", 1),
  );
  await open(app, 1);
  expect(get("heading", "Couldn't read #1 in pin")).toBeTruthy();
  expect(queryAll("link", "Open on GitHub")).toHaveLength(2);
  expect(get("heading", "Row 1 #1"), "what the list knows").toBeTruthy();
  online();
  await app.act(() => get("button", "Try again").focus());
  await app.click(get("button", "Try again"));
  expect(said()).not.toBeNull();
  expect(focused()).toBe("heading Row 1 #1");
});

it("leads back from a missing one", async () => {
  const app = await visit();
  await open(app, 5);
  expect(get("heading", "Couldn't find this pull request")).toBeTruthy();
  await app.click(get("button", "Back to pull requests"));
  expect(focused()).toMatch(/^link Row 5,/);
});

it("keeps what it read when a later read fails, and says so", async () => {
  const app = await visit();
  await open(app, 1);
  const online = app.bridge.failHost(
    { kind: "unreachable", message: "L1 Git could not reach GitHub." },
    pullKey("octo/pin", 1),
  );
  await app.click(refresh());
  expect(said()).not.toBeNull();
  expect(notices()[0]).toMatch(
    /^Offline\. Showing this pull request as of .+, just now\.Try again$/,
  );
  online();
  await app.click(get("button", "Try again"));
  expect(notices()).toEqual([]);
});

const later = (ms: number) =>
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + ms);

it("reads again on focus after half a minute, on the interval, and on the button", async () => {
  const timers = vi.spyOn(window, "setInterval");
  const app = await visit();
  await open(app, 1);
  let now = later(29_000);
  await app.refocusWindow();
  now.mockRestore();
  expect(reads(app.bridge)).toEqual([1]);
  now = later(31_000);
  await app.refocusWindow();
  now.mockRestore();
  expect(reads(app.bridge)).toEqual([1, 1]);
  await app.act(() => {
    for (const [run, ms] of timers.mock.calls)
      if (ms === 15 * 60_000 && typeof run === "function") run();
  });
  timers.mockRestore();
  expect(reads(app.bridge).length).toBeGreaterThan(2);
  const before = reads(app.bridge).length;
  await app.click(refresh());
  expect(reads(app.bridge)).toHaveLength(before + 1);
  await app.click(get("button", "Pull requests"));
  now = later(120_000);
  await app.refocusWindow();
  now.mockRestore();
  expect(reads(app.bridge), "not while the list shows").toHaveLength(
    before + 1,
  );
});

it("reads every half minute while a check runs and the window is visible", async () => {
  const timers = vi.spyOn(window, "setInterval");
  const app = await visit({
    world: ({ host }) =>
      host.details.set(
        pullKey("octo/pin", 1),
        pull(1, { checks: page([check("a", "running")]) }),
      ),
  });
  const tick = async () => {
    const running = timers.mock.calls.filter(([, ms]) => ms === 30_000);
    await app.act(() => {
      for (const [run] of running.slice(-1))
        if (typeof run === "function") run();
    });
    return running.length;
  };
  expect(await tick(), "nothing open").toBe(0);
  await open(app, 1);
  await tick();
  expect(reads(app.bridge)).toEqual([1, 1]);
  const hidden = vi
    .spyOn(document, "visibilityState", "get")
    .mockReturnValue("hidden");
  await tick();
  hidden.mockRestore();
  expect(reads(app.bridge)).toEqual([1, 1]);
  timers.mockRestore();
});

it("asks three times more whether it can merge", async () => {
  const timers = vi.spyOn(window, "setTimeout");
  const app = await visit({
    world: ({ host }) =>
      host.details.set(
        pullKey("octo/pin", 1),
        pull(1, { mergeable: "unknown", mergeState: "unknown" }),
      ),
  });
  const wait = () => {
    const run = timers.mock.calls.filter(([, ms]) => ms === 3_000).at(-1)?.[0];
    return app.act(() => {
      if (typeof run === "function") run();
    });
  };
  await open(app, 1);
  expect(box()).toBe(
    "Can't tell yetGitHub hasn't said yet whether this can merge.",
  );
  for (let times = 0; times < 5; times += 1) await wait();
  expect(reads(app.bridge)).toEqual([1, 1, 1, 1]);
  await app.click(get("button", "Pull requests"));
  await open(app, 1);
  await wait();
  expect(reads(app.bridge), "a new visit starts over").toHaveLength(6);
  timers.mockRestore();
});

it("leaves a locked keychain and a spent limit alone in the background", async () => {
  for (const problem of [
    {
      kind: "keychain" as const,
      problem: "locked",
      message: "The system keychain is locked.",
    },
    {
      kind: "rateLimited" as const,
      message: "The limit is used up.",
      resetAt: Math.ceil(Date.now() / 1_000) + 600,
    },
  ]) {
    const app = await visit();
    await open(app, 1);
    app.bridge.failHost(problem, pullKey("octo/pin", 1));
    await app.click(refresh());
    expect(notices()).toEqual([`${problem.message}Try again`]);
    const asked = asksOfGitHub(app.bridge).length;
    const now = later(120_000);
    await app.refocusWindow();
    now.mockRestore();
    expect(asksOfGitHub(app.bridge), "neither it nor the list").toHaveLength(
      asked,
    );
    await app.click(get("button", "Try again"));
    expect(asksOfGitHub(app.bridge).length).toBeGreaterThan(asked);
  }
});

it("shows the keychain's problem when the read never starts", async () => {
  const app = await visit();
  const unlock = app.bridge.failHost({
    kind: "keychain",
    problem: "locked",
    message: "The system keychain is locked.",
  });
  await app.click(refresh());
  await open(app, 1);
  expect(reads(app.bridge)).toEqual([1]);
  expect(get("region", "Pull requests").textContent).toContain(
    "The system keychain is locked.",
  );
  unlock();
  await app.click(get("button", "Try again"));
  expect(said()).not.toBeNull();
});

it("shows nothing of the last sign-in", async () => {
  const app = await visit();
  await open(app, 1);
  app.bridge.world.host.details.set(
    pullKey("octo/pin", 1),
    pull(1, { body: "For the next account." }),
  );
  await app.click(get("button", "Settings"));
  await app.click(
    get(
      "button",
      "Open Hosts settings".replace("Open ", "").replace(" settings", ""),
    ),
  );
  await app.click(get("button", "Disconnect"));
  await app.click(
    get("button", "Disconnect", get("dialog", "Disconnect GitHub?")),
  );
  await app.click(get("button", "Close settings"));
  expect(detail()).toBeNull();
  expect(get("region", "Pull requests").textContent).toContain(
    "Connect a host to see pull requests",
  );
  expect(document.body.textContent).not.toContain("Reads once.");

  await app.click(get("button", "Sign in to GitHub"));
  await app.click(
    get("button", "Sign in to GitHub", get("dialog", "Settings")),
  );
  await app.click(get("button", "Sign in as @octo"));
  await app.click(get("button", "Close settings"));
  expect(await read(app)).toContain("For the next account.");
});

const lockedKeychain = {
  kind: "keychain" as const,
  problem: "locked",
  message: "The system keychain is locked.",
};
const spent = () => ({
  kind: "rateLimited" as const,
  message: "The limit is used up.",
  resetAt: Math.ceil(Date.now() / 1_000) + 600,
});
const listNotices = () =>
  [...document.querySelectorAll(".pull-list .notice")].map(
    (notice) => notice.textContent,
  );

it("remembers a lock and a limit that only a closed one met", async () => {
  for (const problem of [lockedKeychain, spent()]) {
    const app = await visit();
    await open(app, 1);
    const recover = app.bridge.failHost(problem, pullKey("octo/pin", 1));
    let now = later(31_000);
    await app.refocusWindow();
    now.mockRestore();
    expect(notices()).toEqual([`${problem.message}Try again`]);
    await app.click(get("button", "Pull requests"));
    expect(listNotices()).toEqual([`${problem.message}Try again`]);
    let asked = app.bridge.hostLog.length;
    now = later(200_000);
    await app.refocusWindow();
    expect(app.bridge.hostLog).toHaveLength(asked);

    recover();
    await app.click(get("button", "Try again"));
    expect(listNotices()).toEqual([]);
    asked = app.bridge.hostLog.length;
    now.mockRestore();
    now = later(400_000);
    await app.refocusWindow();
    now.mockRestore();
    expect(app.bridge.hostLog.length).toBeGreaterThan(asked);
  }
});

it("shows the limit instead of asking for one it never read", async () => {
  const app = await visit();
  await open(app, 1);
  const recover = app.bridge.failHost(spent(), pullKey("octo/pin", 1));
  const now = later(31_000);
  await app.refocusWindow();
  now.mockRestore();
  await app.click(get("button", "Pull requests"));
  const asked = asksOfGitHub(app.bridge).length;
  await open(app, 2);
  expect(asksOfGitHub(app.bridge)).toHaveLength(asked);
  expect(get("heading", "Couldn't read #2 in pin")).toBeTruthy();
  expect(get("region", "Pull requests").textContent).toContain(
    "The limit is used up.",
  );
  await app.click(get("button", "Pull requests"));
  await app.click(get("button", /^Recently merged/));
  expect(asksOfGitHub(app.bridge), "nor for a list").toHaveLength(asked);

  recover();
  await app.click(get("button", /^All open/));
  await open(app, 2);
  await app.click(get("button", "Try again"));
  expect(said()).not.toBeNull();
});

it("keeps its tab, its places, and the row to return to over a visit to the history", async () => {
  const app = await visit();
  const list = document.querySelector(".pull-scroll")!;
  await open(app, 2);
  await app.click(tab("Commits"));
  const panel = get("tabpanel", "Commits1");
  await app.click(get("button", "Back to history"));
  expect(query("region", "Pull requests")).toBeNull();
  await app.click(get("button", /^Pull requests/));
  expect(chosen()).toEqual(["Commits1"]);
  expect(get("tabpanel", "Commits1")).toBe(panel);
  expect(document.querySelector(".pull-scroll")).toBe(list);
  expect(focused()).toBe("heading Row 2 #2");
  await app.press("Escape");
  expect(focused()).toMatch(/^link Row 2,/);
});

it("closes, and reads no more, when its repository is removed", async () => {
  const app = await visit();
  await open(app, 3);
  expect(reads(app.bridge)).toEqual([3]);
  await app.click(get("button", "Back to history"));
  await app.contextMenu(get("button", /^other/));
  await app.click(get("menuitem", "Remove"));
  await app.click(get("button", /^Pull requests/));
  expect(detail()).toBeNull();
  expect(link(1)).toBeTruthy();
  expect(() => link(3)).toThrow();
  const now = later(200_000);
  await app.refocusWindow();
  now.mockRestore();
  expect(reads(app.bridge)).toEqual([3]);
});

const resolvedThread = {
  id: "T1",
  review: null,
  path: "a.ts",
  line: 3,
  startLine: null,
  originalLine: 3,
  originalStartLine: null,
  side: "right" as const,
  outdated: false,
  resolved: true,
  hunk: "no hunk",
  can: { reply: true, resolve: true, unresolve: false },
  comments: page([{ id: "TC1", body: "Fixed", by: "sara", at: at(3) }]),
};

it("shows a folded thread that is open again on GitHub", async () => {
  const at = (resolved: boolean) => (world: World) =>
    world.host.details.set(
      pullKey("octo/pin", 1),
      pull(1, { threads: page([{ ...resolvedThread, resolved }]) }),
    );
  const app = await visit({ world: at(true) });
  await open(app, 1);
  const [comment] = resolvedThread.comments.items;
  expect(await read(app)).not.toContain(comment!.body);
  at(false)(app.bridge.world);
  await app.click(refresh());
  expect(await read(app)).toContain(comment!.body);
});

it("keeps what was expanded while another tab shows", async () => {
  const long = `${`${"Long words. ".repeat(20)}\n\n`.repeat(200)}the end`;
  const app = await visit({
    world: ({ host }) =>
      host.details.set(
        pullKey("octo/pin", 1),
        pull(1, { body: long, threads: page([resolvedThread]) }),
      ),
  });
  await open(app, 1);
  await app.click(get("button", /^Resolved/));
  await app.click(get("button", "Show all"));
  await app.click(tab("Checks"));
  expect(said(), "hidden").not.toBeNull();
  expect(query("list", "Conversation")).toBeNull();
  await app.click(tab("Conversation"));
  await read(app);
  expect(get("region", "Thread on a.ts").textContent).toContain("Fixed");
  expect(get("button", "Show less")).toBeTruthy();
});

it("keeps each entry when earlier ones go", async () => {
  const comments = (from: number, to: number) =>
    Array.from({ length: to - from }, (_, index) => ({
      id: `K${from + index}`,
      kind: "comment" as const,
      body: `Comment ${from + index}`,
      by: "sara",
      at: at(2),
    }));
  const app = await visit({
    world: ({ host }) =>
      host.details.set(
        pullKey("octo/pin", 1),
        pull(1, { timeline: page(comments(1, 5), 140) }),
      ),
  });
  await open(app, 1);
  await read(app);
  const entry = () =>
    [...document.querySelectorAll(".entry")].find(({ textContent }) =>
      textContent?.includes("Comment 4"),
    );
  const before = entry();
  expect(before).toBeTruthy();
  app.bridge.world.host.details.set(
    pullKey("octo/pin", 1),
    pull(1, { timeline: page(comments(3, 7), 142) }),
  );
  await app.click(refresh());
  expect(await read(app)).toContain("Comment 6");
  expect(entry()).toBe(before);
});
