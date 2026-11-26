// @vitest-environment happy-dom
import { expect, it } from "vitest";
import type { Oid } from "./domain/repository";
import {
  dialogs,
  focused,
  get,
  installHarness,
  query,
  refRow,
  selectedRow,
} from "./test/appHarness";
import { pullKey, Refusal } from "./test/fakeBridge";
import type { World } from "./test/fakeBridge";
import {
  C6,
  noUpstream,
  OTHER,
  OTHER_TIP,
  PIN,
  PIN_FEATURE,
} from "./test/fixtures";
import {
  bar,
  barButtons,
  barText,
  checkoutWrites,
  holding,
  sent,
  short,
  tried,
  tryButton,
} from "./test/pullRequestCheckouts";
import { open, pull, refresh, visit } from "./test/pullRequests";

installHarness();

type Held = Parameters<typeof holding>[2];
const holds = (copy: Held) => (world: World) => void holding(world, 1, copy);
const where = `Checked out locally in ${tried(1)}`;

it.each([
  [{}, "at 1111111, up to date", []],
  [{ behind: 2 }, "at c0c0c0c, 2 commits behind the pull request", ["Update"]],
  [
    { behind: 1, fetched: false, worktree: "uncommitted" },
    "at c0c0c0c, the pull request has new commits on GitHub, with uncommitted changes",
    ["Update"],
  ],
  [
    { ahead: 1 },
    "at a0a0a0a, 1 commit ahead of the pull request",
    ["Replace with the pull request…"],
  ],
  [
    { ahead: 2, behind: 3 },
    "at a1a1a1a, 2 commits ahead of the pull request and 3 behind it",
    ["Replace with the pull request…"],
  ],
  [
    { behind: 1, worktree: "missing" },
    "at c0c0c0c, 1 commit behind the pull request, but its folder is missing",
    [],
  ],
] as const)(
  "the bar says where the copy stands and offers what moves it: %j",
  async (copy, said, moves) => {
    const app = await visit({ world: holds(copy) });
    await open(app, 1);
    expect(barText()).toBe(`${where} · ${said}`);
    expect(barButtons()).toEqual([
      ...moves,
      "Show in history",
      "Remove worktree",
    ]);
    expect(tryButton()).toBeNull();
    expect(checkoutWrites(app.bridge), "reading writes nothing").toEqual([]);
  },
);

it("a branch checked out in the main worktree offers no Remove worktree", async () => {
  const app = await visit({ world: holds({ worktree: "main" }) });
  await open(app, 1);
  expect(barText()).toBe(
    `Checked out locally in ${PIN} · at 1111111, up to date, with uncommitted changes`,
  );
  expect(barButtons()).toEqual(["Show in history"]);
});

it("Update moves the branch from the tip it saw to the head, and answers the state after it", async () => {
  const app = await visit({ world: holds({ behind: 2 }) });
  await open(app, 1);
  await app.act(() => get("button", "Update").focus());
  await app.click(get("button", "Update"));
  expect(checkoutWrites(app.bridge)).toEqual([
    {
      op: "updatePullRequest",
      path: PIN,
      ...sent(1),
      seen: "c0".repeat(20),
      replace: false,
    },
  ]);
  expect(barText()).toBe(`${where} · at 1111111, up to date`);
  expect(barButtons()).toEqual(["Show in history", "Remove worktree"]);
  expect(focused(), "the button it pressed is gone").toBe("group Local copy");
});

it("an Update that fetches a head without the branch's commits fails in the bar, and the read after it offers Replace", async () => {
  const app = await visit({
    world: holds({ ahead: 2, behind: 1, fetched: false }),
  });
  await open(app, 1);
  expect(barText()).toBe(
    `${where} · at a1a1a1a, the pull request has new commits on GitHub`,
  );
  const reads = app.bridge.count("pullCheckout");
  await app.click(get("button", "Update"));

  const alert = get("alert");
  expect(bar()!.contains(alert)).toBe(true);
  expect(alert.textContent).toBe(
    "Could not update pr/1. pr/1 has 2 commits the pull request does not, so L1 Git did not move it. Replace it with the pull request to leave them behind.",
  );
  expect(app.bridge.count("pullCheckout"), "read again").toBe(reads + 1);
  expect(barText()).toBe(
    `${where} · at a1a1a1a, 2 commits ahead of the pull request and 1 behind it`,
  );
  expect(barButtons()).toContain("Replace with the pull request…");
  await app.refocusWindow();
  expect(get("alert").textContent, "a reread keeps it").toContain(
    "did not move it",
  );
  await app.click(get("button", "Dismiss"));
  expect(query("alert")).toBeNull();
});

it("Replace asks first, names the commits that leave pr/1, and moves only when confirmed", async () => {
  const app = await visit({ world: holds({ ahead: 2, behind: 3 }) });
  await open(app, 1);
  await app.click(get("button", "Replace with the pull request…"));
  expect(dialogs()).toEqual(["Replace pr/1 with the pull request?"]);
  expect(get("dialog").textContent).toContain(
    "pr/1 moves to the pull request's head, 1111111. The 2 commits on pr/1 that aren't in the pull request leave the branch, and L1 Git can't undo that. Uncommitted changes stay, and if the pull request changes the same files, nothing moves.",
  );
  expect(focused()).toBe("button Cancel");
  await app.click(get("button", "Cancel"));
  expect(checkoutWrites(app.bridge)).toEqual([]);

  await app.click(get("button", "Replace with the pull request…"));
  await app.click(get("button", "Replace"));
  expect(checkoutWrites(app.bridge)).toEqual([
    {
      op: "updatePullRequest",
      path: PIN,
      ...sent(1),
      seen: "a1".repeat(20),
      replace: true,
    },
  ]);
  expect(barText()).toBe(`${where} · at 1111111, up to date`);
});

it("Remove deletes a branch the head holds, takes the worktree out of the sidebar, and offers Try it locally again", async () => {
  const app = await visit({
    world: holds({ behind: 1 }),
    saved: { entries: [PIN, OTHER, tried(1)], lastRoot: PIN },
  });
  const listed = () =>
    document.querySelector(`.repository-open[title="${tried(1)}"]`);
  expect(listed()).not.toBeNull();
  await open(app, 1);
  await app.act(() => get("button", "Remove worktree").focus());
  await app.click(get("button", "Remove worktree"));
  expect(checkoutWrites(app.bridge)).toEqual([
    { op: "removePullRequest", path: PIN, ...sent(1), seen: "c0".repeat(20) },
  ]);
  expect(bar()).toBeNull();
  expect(tryButton()).not.toBeNull();
  expect(listed()).toBeNull();
  expect(focused()).toBe("button Try it locally");
});

it("Remove keeps a branch with commits the head lacks, and the bar says so", async () => {
  const app = await visit({ world: holds({ ahead: 2 }) });
  await open(app, 1);
  await app.click(get("button", "Remove worktree"));
  expect(barText()).toBe(
    "Kept locally as pr/1 · at a1a1a1a, 2 commits ahead of the pull request, not checked out",
  );
  expect(get("status", /^Removed worktree/).textContent).toBe(
    "Removed worktree pin-pr-1. Removal cannot be undone.",
  );
  expect(barButtons()).toEqual([
    "Replace with the pull request…",
    "Show in history",
    "",
  ]);
  expect(tryButton()).not.toBeNull();
});

it("a refused Remove says why in the bar and keeps the worktree", async () => {
  const app = await visit({ world: holds({ worktree: "uncommitted" }) });
  await open(app, 1);
  await app.click(get("button", "Remove worktree"));
  expect(get("alert").textContent).toBe(
    "Could not remove the worktree. pin-pr-1 has uncommitted or untracked files. Commit, stash, or discard them there, then remove the worktree.",
  );
  expect(barText()).toBe(
    `${where} · at 1111111, up to date, with uncommitted changes`,
  );
  expect(barButtons()).toContain("Remove worktree");
});

it("a refused Remove's note goes once the copy no longer stands as it said", async () => {
  const app = await visit({ world: holds({ worktree: "uncommitted" }) });
  await open(app, 1);
  await app.click(get("button", "Remove worktree"));
  expect(get("alert").textContent).toContain("Could not remove the worktree.");
  const status = app.bridge.world.statuses.get(tried(1))!;
  app.bridge.world.statuses.set(tried(1), { ...status, entries: [] });
  await app.refocusWindow();
  expect(barText()).toBe(`${where} · at 1111111, up to date`);
  expect(query("alert")).toBeNull();
});

it("Remove of the repository you have open opens the pull request's repository in its place, and says it removed the worktree", async () => {
  const app = await visit({
    world: holds({}),
    saved: { entries: [PIN, OTHER, tried(1)], lastRoot: tried(1) },
  });
  expect(activeRoot()).toBe(tried(1));
  await open(app, 1);
  await app.click(get("button", "Remove worktree"));
  expect(get("status", /^Removed worktree/).textContent).toBe(
    "Removed worktree pin-pr-1. Removal cannot be undone.",
  );
  await app.click(get("button", /^Back to history/));
  expect(activeRoot()).toBe(PIN);
  expect(get("status", /^Removed worktree/).textContent).toContain(
    "Removed worktree pin-pr-1.",
  );
});

it.each([
  ["no other clone of it is saved", [OTHER, tried(1)], undefined],
  ["another clone of it is saved", [OTHER, tried(1), PIN], PIN],
] as const)(
  "Remove of the copy that is the pull request's repository reads nothing of it afterwards, when %s",
  async (_, entries, opens) => {
    const app = await visit({
      world: holds({}),
      saved: { entries: [...entries], lastRoot: tried(1) },
    });
    expect(activeRoot()).toBe(tried(1));
    await open(app, 1);
    app.bridge.reset();
    await app.click(get("button", "Remove worktree"));
    await app.refocusWindow();
    // The overview store lets go of a folder only once the sidebar's next
    // render stops tracking it, so its local refresh may still try it.
    const reads = app.bridge.log.filter(
      ({ op, path }) =>
        path === tried(1) && op !== "removePullRequest" && op !== "overview",
    );
    expect(reads, "nothing reads the removed folder").toEqual([]);
    expect(app.bridge.unexpected).toEqual([]);
    expect(activeRoot()).toBe(opens);
    expect(
      [tryButton() !== null, query("tab", /^Conversation/) !== null],
      "the pull request reads from the clone left, or closes",
    ).toEqual([opens !== undefined, opens !== undefined]);
    expect(bar()).toBeNull();
  },
);

it("a Remove that fails after Git took the worktree away still drops its sidebar row", async () => {
  const app = await visit({
    world: holds({}),
    saved: { entries: [PIN, OTHER, tried(1)], lastRoot: PIN },
    bridge: (bridge) =>
      bridge.respond("removePullRequest", (_request, _world, fallback) => {
        fallback();
        throw new Refusal({
          kind: "lockHeld",
          message: "Another Git process is changing a branch.",
        });
      }),
  });
  const listed = () =>
    document.querySelector(`.repository-open[title="${tried(1)}"]`);
  expect(listed()).not.toBeNull();
  await open(app, 1);
  await app.click(get("button", "Remove worktree"));
  expect(get("alert").textContent).toContain("Could not remove the worktree.");
  expect(listed()).toBeNull();
  expect(tryButton()).not.toBeNull();
});

it("dismissing a note leaves focus on the bar", async () => {
  const app = await visit({ world: holds({ worktree: "uncommitted" }) });
  await open(app, 1);
  await app.click(get("button", "Remove worktree"));
  await app.act(() => get("button", "Dismiss").focus());
  await app.click(get("button", "Dismiss"));
  expect(query("alert")).toBeNull();
  expect(focused()).toBe("group Local copy");
});

it("reads the copy again when the pull request is read again, as when your role in it changed", async () => {
  const app = await visit();
  await open(app, 1);
  const reads = app.bridge.count("pullCheckout");
  app.bridge.world.host.details.set(
    pullKey("octo/pin", 1),
    pull(1, { viewerPermission: "read" }),
  );
  await app.click(refresh());
  expect(app.bridge.count("pullCheckout")).toBe(reads + 1);
  await app.click(tryButton()!);
  expect(document.querySelector(".pull-try-pushes")!.textContent).toContain(
    "You can't push to this repository",
  );
});

it("runs one write at a time: the bar's moves wait while one runs", async () => {
  const app = await visit({ world: holds({ behind: 1 }) });
  await open(app, 1);
  const held = app.bridge.hold("updatePullRequest");
  await app.click(get("button", "Update"));
  await held.arrived;
  expect(bar()!.getAttribute("aria-busy")).toBe("true");
  expect(get("button", "Remove worktree").getAttribute("aria-disabled")).toBe(
    "true",
  );
  await app.click(get("button", "Remove worktree"));
  await app.click(get("button", "Update"));
  held.release();
  await app.settle();
  expect(checkoutWrites(app.bridge).map(({ op }) => op)).toEqual([
    "updatePullRequest",
  ]);
});

it("Show in history leaves the pull request and selects the copy's tip", async () => {
  const app = await visit({ world: holds({}) });
  await open(app, 1);
  await app.act(() => get("button", "Show in history").focus());
  await app.click(get("button", "Show in history"));
  await app.flushFrames();
  expect(query("region", "Pull requests")).toBeNull();
  expect(selectedRow()).toMatch(/^First/);
  expect(focused(), "keys move from the selected row").toBe("grid Commits");
});

it("Show in history reveals a tip that a solo rule hides, and selects it", async () => {
  const app = await visit({
    world: (world) => {
      world.host.details.set(pullKey("octo/pin", 1), {
        ...pull(1),
        head: { ...pull(1).head, oid: C6 },
      });
      holding(world, 1, {}, { head: C6 });
    },
  });
  await app.click(get("button", /^Back to history/));
  await app.click(refRow("refs/heads/main")!);
  await app.runPaletteItem("Solo main");
  await app.click(get("button", /^Pull requests/));
  await open(app, 1);
  await app.click(get("button", "Show in history"));
  await app.flushFrames();
  expect(query("status", /soloed/)).toBeNull();
  expect(selectedRow()).toBe("Topic work, Pin Author, 6666666");
});

it("Show in history waits while Remove runs", async () => {
  const app = await visit({ world: holds({}) });
  await open(app, 1);
  const held = app.bridge.hold("removePullRequest");
  await app.click(get("button", "Remove worktree"));
  await held.arrived;
  const show = get("button", "Show in history");
  expect(show.getAttribute("aria-disabled")).toBe("true");
  await app.click(show);
  expect(query("region", "Pull requests")).not.toBeNull();
  held.release();
  await app.settle();
});

it("Show in history stays in the open worktree when it shares the pull request's repository", async () => {
  const app = await visit({
    world: (world) => {
      holding(world, 1, {});
      featureOpen(world);
    },
    saved: { entries: [PIN, PIN_FEATURE, OTHER], lastRoot: PIN_FEATURE },
  });
  await open(app, 1);
  await app.click(get("button", "Show in history"));
  expect(activeRoot()).toBe(PIN_FEATURE);
  expect(selectedRow()).toMatch(/^First/);
});

it("reads and writes the pull request's own repository, and Show in history opens it", async () => {
  const app = await visit({
    world: (world) => {
      world.host.details.set(pullKey("octo/other", 3), {
        ...pull(3),
        head: { ...pull(3).head, oid: OTHER_TIP },
      });
      holding(world, 3, { behind: 1 }, { root: OTHER, head: OTHER_TIP });
    },
  });
  await open(app, 3);
  expect(app.bridge.log.filter(({ op }) => op === "pullCheckout")).toEqual([
    expect.objectContaining({ op: "pullCheckout", path: OTHER }),
  ]);
  await app.click(get("button", "Update"));
  expect(checkoutWrites(app.bridge)).toEqual([
    expect.objectContaining({ op: "updatePullRequest", path: OTHER }),
  ]);
  expect(barText()).toBe(
    `Checked out locally in ${tried(3, "other")} · at ${short(OTHER_TIP)}, up to date`,
  );
  await app.click(get("button", "Show in history"));
  expect(activeRoot()).toBe(OTHER);
  await app.settle();
  expect(selectedRow()).toMatch(/^Other tip/);
});

it("reads again when the window regains focus and when the head moves, and never fetches to read", async () => {
  const app = await visit({ world: holds({}) });
  await open(app, 1);
  expect(app.bridge.count("pullCheckout")).toBe(1);
  await app.refocusWindow();
  expect(app.bridge.count("pullCheckout")).toBe(2);
  const moved = "7".repeat(40) as Oid;
  app.bridge.world.host.details.set(pullKey("octo/pin", 1), {
    ...pull(1),
    head: { ...pull(1).head, oid: moved },
  });
  await app.click(get("button", "Back to history"));
  await app.click(get("button", /^Pull requests/));
  const heads = app.bridge.log
    .filter(({ op }) => op === "pullCheckout")
    .map((request) => (request.head as { oid: string }).oid);
  expect(heads.at(-1)).toBe(moved);
  expect(barText()).toBe(
    `${where} · at 1111111, the pull request has new commits on GitHub`,
  );
  expect(app.bridge.count("fetchCommits")).toBe(0);
  expect(checkoutWrites(app.bridge)).toEqual([]);
});

const activeRoot = () =>
  document
    .querySelector(".repository-row.active .repository-open")
    ?.getAttribute("title");

function featureOpen(world: World) {
  const pin = world.snapshots.get(PIN)!;
  const head = pin.worktrees.find(({ root }) => root === PIN_FEATURE)!.head;
  world.snapshots.set(PIN_FEATURE, {
    ...pin,
    root: PIN_FEATURE,
    name: "pin-feature",
    head,
    worktrees: pin.worktrees.map((worktree) => ({
      ...worktree,
      current: worktree.root === PIN_FEATURE,
    })),
  });
  world.overviews.set(PIN_FEATURE, {
    ...world.overviews.get(PIN)!,
    root: PIN_FEATURE,
    name: "pin-feature",
  });
  world.pushes.set(PIN_FEATURE, noUpstream());
}
