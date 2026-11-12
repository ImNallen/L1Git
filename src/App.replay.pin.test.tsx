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
  openFirstFile,
  paletteTitles,
  query,
  queryAll,
  refRow,
  repositoryRow,
  selectedRow,
} from "./test/appHarness";
import type { Harness } from "./test/appHarness";
import {
  activeMerge,
  history,
  OTHER,
  PIN,
  PIN_FEATURE,
  replayInProgress,
  replayReviewFor,
} from "./test/fixtures";
import type { Applied, ReplayOf, RepositoryRoot } from "./domain/repository";

installHarness();

const PANEL = /^(Cherry-picking|Reverting) /;
const NOTICES = "Cherry-pick or revert";

it("a cherry-pick started in a terminal opens the panel on the next refocus", async () => {
  const app = await mountApp();
  expect(query("region", PANEL)).toBeNull();
  app.bridge.world.merges.set(PIN, replayInProgress(PIN, ["notes.txt"]));
  await app.refocusWindow();
  expect(get("region", PANEL).textContent).toContain("Picked commit");
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
  expect(get("region", /onto feature$/)).toBeTruthy();
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
  await app.click(get("button", "Finish cherry-pick"));
  expect(app.bridge.lines((request) => request.op === "write")).toEqual([
    `write ${PIN} finishReplay`,
  ]);
  expect(query("region", PANEL)).toBeNull();
  expect(
    await toolbarItem(app, "More", "Undo Cherry-pick “Picked commit”"),
  ).toBeTruthy();
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
  expect(get("region", "Discarded").textContent).toContain(
    "notes.txt unsaved result draft",
  );
  expect(get("region", "Discarded").textContent).toContain(
    "A draft you change after this opens is kept.",
  );
  expect(app.bridge.count("replayAbort")).toBe(0);
  await app.click(get("button", "Abort revert"));
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
  expect(get("region", NOTICES).textContent).toContain("Revert aborted.");
  expect(query("button", "Finish revert")).toBeNull();
});

it("the progress in the strip selects the worktree and opens the inspector", async () => {
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
  await app.click(get("button", "1 of 1 resolved"));
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

const REVIEW = "Cherry-pick this commit";

async function fromMenu(app: Harness, row: string, item: string) {
  await app.contextMenu(historyRow(row));
  await app.click(get("menuitem", item));
}

/** Answers a replay write as the core does: an entry the Undo button then reads. */
function landing(app: Harness) {
  app.bridge.respond("write", (request, world, fallback) => {
    const entry = fallback() as Applied;
    world.histories.set(request.path as RepositoryRoot, history(entry));
    return entry;
  });
}

const writes = (app: Harness) =>
  app.bridge.lines((request) => request.op === "write");
/** Each distinct review read. StrictMode reads a mounted dialog's twice. */
const reviews = (app: Harness) => [
  ...new Set(
    app.bridge.log
      .filter(({ op }) => op === "replayReview")
      .map(({ path, of }) => {
        const { kind, commit } = of as ReplayOf;
        return `${kind} ${commit[0]} in ${path}`;
      }),
  ),
];

it("the commit menu names the branch and opens the review for that commit", async () => {
  const app = await mountApp();
  await app.contextMenu(historyRow("Release,"));
  expect(get("menuitem", "Cherry-pick onto main…")).toBeTruthy();
  expect(get("menuitem", "Revert on main…")).toBeTruthy();
  app.bridge.reset();
  await app.click(get("menuitem", "Revert on main…"));
  expect(dialogs()).toEqual(["Revert this commit"]);
  expect(reviews(app)).toEqual([`revert 3 in ${PIN}`]);
});

it("the commit menu has no branch to name on a detached HEAD, and the review says why", async () => {
  const app = await mountApp({
    world: (world) => {
      const snapshot = world.snapshots.get(PIN)!;
      const head = {
        kind: "detached",
        oid: "4".repeat(40),
      } as (typeof snapshot)["head"];
      world.snapshots.set(PIN, {
        ...snapshot,
        head,
        worktrees: snapshot.worktrees.map((worktree) =>
          worktree.root === PIN ? { ...worktree, head } : worktree,
        ),
      });
    },
  });
  app.bridge.fail("replayReview", {
    kind: "conflict",
    message: "Cherry-pick needs a checked-out local branch.",
  });
  await app.contextMenu(historyRow("Release,"));
  expect(get("menuitem", "Revert…")).toBeTruthy();
  await app.click(get("menuitem", "Cherry-pick onto current branch…"));
  expect(get("alert", /needs a checked-out local branch/)).toBeTruthy();
  expect(
    (get("button", "Cherry-pick", get("dialog", REVIEW)) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

it("the commit menu holds no merge-commit rule, and the review refuses it", async () => {
  const app = await mountApp({
    world: (world) => {
      const snapshot = world.snapshots.get(PIN)!;
      world.snapshots.set(PIN, {
        ...snapshot,
        commits: snapshot.commits.map((commit) =>
          commit.subject === "Release"
            ? { ...commit, parents: [commit.parents[0]!, "1".repeat(40)] }
            : commit,
        ) as typeof snapshot.commits,
      });
    },
  });
  app.bridge.fail("replayReview", {
    kind: "conflict",
    message: "3333333 is a merge commit.",
  });
  await fromMenu(app, "Release,", "Cherry-pick onto main…");
  expect(get("alert", "3333333 is a merge commit.")).toBeTruthy();
  expect(writes(app)).toEqual([]);
});

it("the menu entries are disabled and write nothing while the worktree is not idle", async () => {
  const app = await mountApp({
    world: (world) => world.merges.set(PIN, activeMerge(PIN, ["notes.txt"])),
  });
  await app.contextMenu(historyRow("Release,"));
  const item = get("menuitem", /^Cherry-pick onto main…/);
  expect(item.getAttribute("aria-disabled")).toBe("true");
  expect(item.textContent).toContain("finish any operation");
  await app.click(item);
  expect(dialogs()).toEqual([]);
  expect(reviews(app)).toEqual([]);
  expect(
    get("menuitem", /^Revert on main…/).getAttribute("aria-disabled"),
  ).toBe("true");
});

it("a clean pick from the menu writes the review, closes, and lands in Undo with no notice", async () => {
  const app = await mountApp();
  landing(app);
  const noticesBefore = queryAll("alert").length;
  await fromMenu(app, "Release,", "Cherry-pick onto main…");
  const dialog = get("dialog", REVIEW);
  expect(dialog.textContent).toContain("3".repeat(40));
  expect(dialog.textContent).toContain("refs/heads/main");
  expect(dialog.textContent).toContain("4".repeat(40));
  expect(dialog.textContent).toContain(
    "Applies cleanly. L1 Git will commit it straight away, and Undo removes it.",
  );
  await app.click(get("button", "Cherry-pick", dialog));
  expect(app.bridge.log.filter(({ op }) => op === "write")).toEqual([
    expect.objectContaining({
      path: PIN,
      operation: {
        kind: "replay",
        review: replayReviewFor(PIN, {
          kind: "cherryPick",
          commit: "3".repeat(40),
        } as ReplayOf),
      },
      expect: {
        head: {
          kind: "attached",
          reference: "refs/heads/main",
          oid: "4".repeat(40),
        },
      },
    }),
  ]);
  expect(dialogs()).toEqual([]);
  expect(queryAll("alert").length).toBe(noticesBefore);
  expect(focused(), "focus returns to History").toBe("grid Commits");
  expect(
    await toolbarItem(app, "More", "Undo Cherry-pick “Picked subject”"),
  ).toBeTruthy();
});

it("a clean revert from the menu reads Revert on its button and in Undo", async () => {
  const app = await mountApp();
  landing(app);
  await fromMenu(app, "Release,", "Revert on main…");
  await app.click(get("button", "Revert", get("dialog", "Revert this commit")));
  expect(dialogs()).toEqual([]);
  expect(
    await toolbarItem(app, "More", "Undo Revert “Picked subject”"),
  ).toBeTruthy();
});

it("a stopped pick closes with no failure notice, and the panel takes over", async () => {
  const app = await mountApp();
  const noticesBefore = queryAll("alert").length;
  app.bridge.respond("replayReview", (request) =>
    replayReviewFor(request.path as RepositoryRoot, request.of as ReplayOf, {
      kind: "conflict",
      paths: ["notes.txt"],
    }),
  );
  app.bridge.fail("write", {
    kind: "replayStopped",
    message: "The cherry-pick stopped on a conflict, so Git made no commit.",
    output: "",
  });
  app.bridge.world.merges.set(
    PIN,
    replayInProgress(PIN, ["notes.txt"], {
      unresolved: ["notes.txt"],
      tree: null,
    }),
  );
  await fromMenu(app, "Release,", "Cherry-pick onto main…");
  expect(get("dialog", REVIEW).textContent).toContain(
    "Will conflict in: notes.txt. You resolve it in the app, then finish or abort.",
  );
  await app.click(get("button", "Cherry-pick", get("dialog", REVIEW)));
  expect(dialogs()).toEqual([]);
  expect(queryAll("alert").length).toBe(noticesBefore);
  expect(get("region", PANEL).textContent).toContain(
    "1 file still has a conflict.",
  );
});

it("a hook that stops a clean pick shows Git's output in the panel, not a notice", async () => {
  const app = await mountApp();
  const message =
    "Git could not make the commit. The result is staged. Finish or abort the cherry-pick.";
  app.bridge.fail("write", {
    kind: "replayStopped",
    message,
    output: "hook says no\n",
  });
  await fromMenu(app, "Release,", "Cherry-pick onto main…");
  app.bridge.world.merges.set(
    PIN,
    replayInProgress(PIN, ["notes.txt"], {
      commit: "3".repeat(40) as ReplayOf["commit"],
    }),
  );
  await app.click(get("button", "Cherry-pick", get("dialog", REVIEW)));
  expect(dialogs()).toEqual([]);
  expect(query("alert", /Could not/)).toBeNull();
  expect(get("region", PANEL)).toBeTruthy();
  const stopped = get("alert", /^Git could not make the commit/);
  expect(stopped.textContent).toContain(message);
  expect(stopped.textContent).toContain("hook says no");
});

it("a stale answer keeps the review open, says to review again, and leaves no notice", async () => {
  const app = await mountApp();
  await fromMenu(app, "Release,", "Cherry-pick onto main…");
  app.bridge.fail("write", {
    kind: "staleView",
    reason: "headMoved",
    message: "HEAD moved.",
  });
  app.bridge.reset();
  await app.click(get("button", "Cherry-pick", get("dialog", REVIEW)));
  expect(dialogs()).toEqual([REVIEW]);
  expect(get("alert", /Review it again\./)).toBeTruthy();
  expect(query("alert", /Could not/)).toBeNull();
  expect(reviews(app)).toEqual([`cherryPick 3 in ${PIN}`]);
});

it("the review closes, and a delayed answer stays closed, when the active worktree changes", async () => {
  const app = await mountApp();
  await app.click(historyRow("Uncommitted changes in pin-feature,"));
  await app.click(historyRow("Release,"));
  const pending = app.bridge.hold("replayReview", PIN_FEATURE);
  await app.contextMenu(historyRow("Release,"));
  await app.click(get("menuitem", "Cherry-pick onto feature…"));
  await pending.arrived;
  expect(dialogs()).toEqual([REVIEW]);
  const snapshot = app.bridge.world.snapshots.get(PIN)!;
  app.bridge.world.snapshots.set(PIN, {
    ...snapshot,
    worktrees: snapshot.worktrees.filter(
      (worktree) => worktree.root !== PIN_FEATURE,
    ),
  });
  await app.refocusWindow();
  expect(dialogs()).toEqual([]);
  pending.release();
  await app.settle();
  expect(dialogs()).toEqual([]);
  expect(writes(app)).toEqual([]);
  expect(app.bridge.count("replayReview", PIN)).toBe(0);
});

it("a delayed review stays closed after switching repositories", async () => {
  const app = await mountApp();
  const pending = app.bridge.hold("replayReview", PIN);
  await app.contextMenu(historyRow("Release,"));
  await app.click(get("menuitem", "Revert on main…"));
  await pending.arrived;
  expect(dialogs()).toEqual(["Revert this commit"]);
  await app.click(repositoryRow(OTHER));
  expect(dialogs()).toEqual([]);
  pending.release();
  await app.settle();
  expect(dialogs()).toEqual([]);
  expect(app.bridge.count("replayReview", OTHER)).toBe(0);
  expect(writes(app)).toEqual([]);
  await app.click(repositoryRow(PIN));
  expect(dialogs(), "returning does not reopen it").toEqual([]);
});

it("a linked worktree's selection is the destination, not the repository root", async () => {
  const app = await mountApp();
  landing(app);
  await app.click(historyRow("Uncommitted changes in pin-feature,"));
  await app.click(historyRow("Release,"));
  app.bridge.reset();
  await fromMenu(app, "Release,", "Cherry-pick onto feature…");
  expect(reviews(app)).toEqual([`cherryPick 3 in ${PIN_FEATURE}`]);
  const dialog = get("dialog", REVIEW);
  expect(dialog.textContent).toContain("refs/heads/feature");
  expect(dialog.textContent).toContain("5".repeat(40));
  await app.click(get("button", "Cherry-pick", dialog));
  expect(writes(app)).toEqual([`write ${PIN_FEATURE} replay`]);
  expect(
    await toolbarItem(app, "More", "Undo Cherry-pick “Picked subject”"),
  ).toBeTruthy();
});

it("the palette offers both for the selected commit and opens the same review", async () => {
  const app = await mountApp();
  await app.click(historyRow("Release,"));
  app.bridge.reset();
  await app.runPaletteItem("Cherry-pick onto main…");
  expect(dialogs()).toEqual([REVIEW]);
  expect(reviews(app)).toEqual([`cherryPick 3 in ${PIN}`]);
  await app.click(get("button", "Cancel"));
  await app.runPaletteItem("Revert on main…");
  expect(dialogs()).toEqual(["Revert this commit"]);
});

it("the palette drops both entries while the worktree is not idle or no commit is selected", async () => {
  const app = await mountApp();
  const offered = async () => {
    await app.press("p", { ctrlKey: true });
    const titles = paletteTitles().filter((title) =>
      /^(Cherry-pick|Revert)/.test(title),
    );
    await app.press("Escape");
    return titles;
  };
  expect(await offered()).toEqual([
    "Cherry-pick onto main…",
    "Revert on main…",
  ]);
  await app.click(historyRow("Uncommitted changes in pin,"));
  expect(await offered()).toEqual([]);
  await app.click(historyRow("Release,"));
  app.bridge.world.merges.set(PIN, replayInProgress(PIN, ["notes.txt"]));
  await app.refocusWindow();
  expect(await offered()).toEqual([]);
});
