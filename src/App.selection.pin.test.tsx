// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import {
  dialogs,
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
import { C3, C4, OTHER, OTHER_TIP, PIN } from "./test/fixtures";
import { oidSchema, snapshotSchema } from "./domain/repository";

installHarness();

it("Edit message selects the new HEAD in the settled snapshot", async () => {
  const reworded = oidSchema.parse("d".repeat(40));
  const app = await mountApp({
    bridge: (bridge) =>
      bridge.respond("write", (_request, world, fallback) => {
        const snapshot = world.snapshots.get(PIN)!;
        const head = {
          kind: "attached",
          reference: "refs/heads/main",
          oid: reworded,
        };
        world.snapshots.set(
          PIN,
          snapshotSchema.parse({
            ...snapshot,
            head,
            branches: snapshot.branches.map((branch) =>
              branch.name === "main" ? { ...branch, oid: reworded } : branch,
            ),
            worktrees: snapshot.worktrees.map((worktree) =>
              worktree.root === PIN ? { ...worktree, head } : worktree,
            ),
            commits: [
              {
                ...snapshot.commits[2]!,
                oid: reworded,
                subject: "Reworded",
                parents: [C3],
              },
              ...snapshot.commits,
            ],
          }),
        );
        return fallback();
      }),
  });
  await app.contextMenu(historyRow("Main tip,"));
  await app.click(get("menuitem", "Edit message…"));
  await app.type(get("textbox", "Summary"), "Reworded");
  await app.click(get("button", "Save message"));
  expect(app.bridge.lines((request) => request.op === "write")).toEqual([
    "write /fixture/pin editMessage",
  ]);
  expect(dialogs()).toEqual([]);
  expect(selectedRow()).toBe("Reworded, Pin Author, ddddddd");
});

it("returning to a repository restores its selection and scroll", async () => {
  const app = await mountApp();
  await app.click(historyRow("Second,"));
  const scroller = document.querySelector<HTMLElement>(".history-scroll")!;
  await app.act(() => {
    scroller.scrollTop = 72;
    scroller.dispatchEvent(new Event("scroll"));
  });
  await app.click(repositoryRow(OTHER));
  expect(selectedRow()).toBe("Other tip, Pin Author, 8888888");
  expect(document.querySelector(".history-scroll")!.scrollTop).toBe(0);
  await app.click(repositoryRow(PIN));
  expect(selectedRow()).toBe("Second, Pin Author, 2222222");
  expect(document.querySelector(".history-scroll")!.scrollTop).toBe(72);
});

it("selecting in History clears the sidebar jump; the jump itself keeps it", async () => {
  const app = await mountApp();
  await app.click(historyRow("Release,"));
  await app.click(get("button", "Hide topic"));
  await app.click(refRow("refs/heads/topic")!);
  expect(get("status", /hidden in the graph/)).toBeTruthy();
  await app.refocusWindow();
  expect(
    get("status", /hidden in the graph/),
    "a reread keeps the jump",
  ).toBeTruthy();
  await app.click(historyRow("Second,"));
  expect(query("status", /hidden in the graph/)).toBeNull();
});

it("removing a repository forgets its last branch and its rule", async () => {
  const app = await mountApp();
  await app.click(get("button", "Hide topic"));
  await app.click(refRow("refs/heads/feature")!);
  expect(refRow("refs/heads/feature")?.getAttribute("aria-current")).toBe(
    "true",
  );
  await app.contextMenu(repositoryRow(PIN));
  await app.click(get("menuitem", "Remove"));
  expect(query("grid", "Commits")).toBeNull();

  await app.press("o", { ctrlKey: true, target: document.body });
  await app.click(get("option", /^Local folder/));
  await app.type(get("combobox", "Path"), PIN);
  await app.click(get("button", "Open", get("dialog", "Add repository")));
  expect(dialogs()).toEqual([]);
  expect(get("button", "Hide topic"), "the rule is forgotten").toBeTruthy();
  await app.click(historyRow("Feature work,"));
  expect(
    refRow("refs/heads/feature")?.getAttribute("aria-current"),
    "the last branch is forgotten",
  ).toBeNull();
});

it("a reread keeps the selection, so an open file stays open", async () => {
  const app = await mountApp();
  await openFirstFile(app);
  expect(get("region", "Changes to notes.txt")).toBeTruthy();
  await app.refocusWindow();
  expect(app.bridge.count("snapshot", PIN)).toBeGreaterThan(1);
  expect(get("region", "Changes to notes.txt")).toBeTruthy();
});

it("a committed file offers History and Blame beside the diff styles", async () => {
  const app = await mountApp({
    bridge: (bridge) =>
      bridge.respond("fileHistory", (_request, world) =>
        world.snapshots
          .get(PIN)!
          .commits.filter(({ subject }) =>
            ["Main tip", "Release"].includes(subject),
          )
          .map((commit) => ({ commit, path: "notes.txt" })),
      ),
  });
  await openFirstFile(app);
  const views = get("group", "File view");
  expect(
    queryAll("button", undefined, views).map((b) => b.textContent),
  ).toEqual(["Unified", "Split", "History", "Blame"]);
  await app.click(get("button", "History", views));
  expect(get("button", "History", views).getAttribute("aria-pressed")).toBe(
    "true",
  );
  expect(get("button", "Unified", views).getAttribute("aria-pressed")).toBe(
    "false",
  );
  expect(
    queryAll(
      "option",
      undefined,
      get("listbox", "Commits that changed this file"),
    ).map(
      (option) => option.querySelector(".file-revision-subject")?.textContent,
    ),
  ).toEqual(["Main tip", "Release"]);
});

it("a reread under an open blame keeps its file, so scrolling it logs no error", async () => {
  const lines = Array.from({ length: 400 }, (_, index) => `line ${index + 1}`);
  const app = await mountApp({
    bridge: (bridge) =>
      bridge.respond("blame", () => ({
        kind: "text",
        contents: `${lines.join("\n")}\n`,
        lossy: false,
        ranges: [
          {
            oid: C4,
            start: 1,
            lines: lines.length,
            author: "Pin Author",
            email: "pin@example.test",
            timestamp: 1_700_000_004,
            summary: "Main tip",
          },
        ],
      })),
  });
  await openFirstFile(app);
  await app.runPaletteItem("Show blame");
  const errors = vi.spyOn(console, "error");
  try {
    await app.refocusWindow();
    const scroller = document.querySelector<HTMLElement>(".file-blame")!;
    await app.act(() => {
      scroller.scrollTop = 2400;
      scroller.dispatchEvent(new Event("scroll"));
    });
    await app.flushFrames();
    expect(app.bridge.count("snapshot", PIN)).toBeGreaterThan(1);
    expect(errors.mock.calls).toEqual([]);
  } finally {
    errors.mockRestore();
  }
});

it("a pending jump resolves against a reread that failed, which keeps the cached view", async () => {
  const base = oidSchema.parse("c".repeat(40));
  const app = await mountApp({
    world: (world) => {
      const other = world.snapshots.get(OTHER)!;
      world.snapshots.set(
        OTHER,
        snapshotSchema.parse({
          ...other,
          branches: [
            ...other.branches,
            {
              kind: "local",
              reference: "refs/heads/base",
              name: "base",
              oid: base,
              upstream: null,
            },
          ],
          commits: [
            { ...other.commits[0]!, parents: [base] },
            {
              ...other.commits[0]!,
              oid: base,
              parents: [],
              subject: "Other base",
              timestamp: 1_700_000_007,
            },
          ],
        }),
      );
    },
  });
  await app.click(repositoryRow(OTHER));
  expect(selectedRow()).toBe("Other tip, Pin Author, 8888888");
  await app.click(repositoryRow(PIN));
  app.bridge.fail(
    "snapshot",
    { kind: "timedOut", message: "Reading other took too long." },
    OTHER,
  );
  await app.click(repositoryRow(OTHER));
  await app.click(refRow("refs/heads/base", OTHER)!);
  expect(
    get("alert", /The last successful view is retained/),
    "the reread failed",
  ).toBeTruthy();
  expect(selectedRow()).toBe("Other base, Pin Author, ccccccc");
  expect(OTHER_TIP).not.toBe(base);
});
