// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import {
  dialogs,
  dirtyResolution,
  focused,
  get,
  historyRow,
  installHarness,
  mountApp,
  query,
  queryAll,
  refRow,
  repositoryRow,
  selectedRow,
} from "./test/appHarness";
import type { Harness } from "./test/appHarness";
import {
  C6,
  OTHER,
  PIN,
  PIN_FEATURE,
  pinOverview,
  readyPush,
} from "./test/fixtures";
import { overviewSchema } from "./domain/overview";
import { pushReportSchema } from "./domain/push";
import { snapshotSchema } from "./domain/repository";
import { RECENTS_KEY } from "./domain/recents";
import { EXPANDED_KEY } from "./expandedRepositories";
import { COLUMNS_KEY } from "./historyColumns";
import { VISIBILITY_KEY } from "./branchVisibility";

installHarness();

const alerts = () => queryAll("alert").map((alert) => alert.textContent);

function answerPush(app: Harness, outcome: unknown) {
  app.bridge.respond("push", () =>
    pushReportSchema.parse({
      outcome,
      refresh: {
        kind: "refreshed",
        overview: pinOverview(),
        availability: readyPush(),
      },
    }),
  );
}

it("the push notice is role=status on success and role=alert on failure", async () => {
  const app = await mountApp();
  answerPush(app, { kind: "pushed" });
  await app.click(get("button", "Push to origin/main"));
  expect(get("status", /origin\/main/).textContent).toMatchInlineSnapshot(
    `"Pushed main to origin/main. "`,
  );
  answerPush(app, { kind: "rejected", message: "The remote said no." });
  await app.click(get("button", "Push to origin/main"));
  expect(query("status", /origin\/main/)).toBeNull();
  expect(alerts()).toMatchInlineSnapshot(`
    [
      "Push rejected. The remote said no. ",
    ]
  `);
});

it("the first persistence error among the four sources is shown", async () => {
  const app = await mountApp();
  const failing = new Set<string>();
  const setItem = localStorage.setItem.bind(localStorage);
  const spy = vi
    .spyOn(localStorage, "setItem")
    .mockImplementation((key: string, value: string) => {
      if (failing.has(key)) throw new Error("The quota is full.");
      setItem(key, value);
    });
  try {
    failing.add(VISIBILITY_KEY);
    await app.click(get("button", "Hide topic"));
    expect(alerts()).toEqual([
      "Hidden and soloed branches changed for this session. Could not save them.",
    ]);
    failing.add(COLUMNS_KEY);
    await app.contextMenu(get("columnheader", "Graph"));
    await app.click(queryAll("menuitemcheckbox")[0]!);
    expect(alerts()).toEqual([
      "History columns changed for this session. Could not save them.",
    ]);
    failing.add(EXPANDED_KEY);
    await app.click(get("button", "Expand other"));
    expect(alerts()).toEqual([
      "Expanded repositories changed for this session. Could not save them.",
    ]);
    failing.add(RECENTS_KEY);
    await app.click(repositoryRow(OTHER));
    expect(alerts()).toEqual([
      "The repository list could not be saved. Allow local storage to restore repositories after restart.",
    ]);
  } finally {
    spy.mockRestore();
  }
});

it("a read error keeps the last view and offers Try again", async () => {
  const app = await mountApp();
  app.bridge.fail("snapshot", {
    kind: "timedOut",
    message: "Reading this repository took too long.",
  });
  await app.refocusWindow();
  expect(alerts()).toEqual([
    "Reading this repository took too long. The last successful view is retained.Try again",
  ]);
  expect(selectedRow()).toBe("Topic work, Pin Author, 6666666");
  expect(get("button", "Try again")).toBeTruthy();
});

it("each repository warning renders one alert", async () => {
  await mountApp({
    bridge: (bridge) =>
      bridge.respond("overview", (request) =>
        overviewSchema.parse({
          ...pinOverview(),
          root: request.path,
          fetch:
            request.mode === "remote" && request.path === PIN
              ? {
                  at: 1_700_000_300,
                  changed: false,
                  coalesced: false,
                  remotes: [
                    {
                      remote: "origin",
                      outcome: {
                        kind: "failed",
                        failure: "auth",
                        message: "Check your credentials.",
                      },
                    },
                    { remote: "mirror", outcome: { kind: "fetched" } },
                    {
                      remote: "backup",
                      outcome: {
                        kind: "failed",
                        failure: "network",
                        message: "The host is unreachable.",
                      },
                    },
                  ],
                }
              : null,
          ...(request.path === PIN
            ? {}
            : {
                commonDir: "/fixture/other/.git",
                name: "other",
                branches: [],
              }),
        }),
      ),
  });
  expect(alerts()).toEqual([
    "origin: Authentication failed. Check your credentials.",
    "backup: Network error. The host is unreachable.",
  ]);
});

it("the hidden-jump notice offers Show <branch> and reveals it", async () => {
  const app = await mountApp();
  await app.click(historyRow("Release,"));
  await app.click(get("button", "Hide topic"));
  await app.click(refRow("refs/heads/topic")!);
  expect(selectedRow(), "the jump cannot select a hidden commit").toBe(
    "Release, Pin Author, 3333333",
  );
  expect(get("status", /hidden in the graph/).textContent).toBe(
    "topic is hidden in the graph.Show topic",
  );
  await app.click(
    get("button", "Show topic", get("status", /hidden in the graph/)),
  );
  expect(query("status", /hidden in the graph/)).toBeNull();
  expect(selectedRow()).toBe("Topic work, Pin Author, 6666666");
  expect(focused()).toBe("grid Commits");
  expect(get("button", "Hide topic")).toBeTruthy();
});

it("the hidden-jump notice says when a ref is outside the soloed branches, and offers Show all branches for a tag", async () => {
  const app = await mountApp({
    world: (world) => {
      const snapshot = world.snapshots.get(PIN)!;
      world.snapshots.set(
        PIN,
        snapshotSchema.parse({
          ...snapshot,
          tags: [
            ...snapshot.tags,
            {
              reference: "refs/tags/t6",
              name: "t6",
              oid: C6,
              object: C6,
              annotated: false,
            },
          ],
        }),
      );
    },
  });
  await app.click(refRow("refs/heads/main")!);
  await app.runPaletteItem("Solo main");
  await app.click(refRow("refs/heads/topic")!);
  expect(get("status", /soloed/).textContent).toBe(
    "topic is outside the soloed branches.Show topic",
  );
  await app.click(refRow("refs/tags/t6")!);
  const notice = get("status", /soloed/);
  expect(notice.textContent).toBe(
    "t6 is outside the soloed branches.Show all branches",
  );
  await app.click(get("button", "Show all branches", notice));
  expect(query("status", /soloed/)).toBeNull();
  expect(get("button", "Hide main"), "the solo rule is gone").toBeTruthy();
  expect(selectedRow()).toBe("Topic work, Pin Author, 6666666");
});

it("the unloaded-jump notice names the loaded commit count", async () => {
  const app = await mountApp();
  await app.click(refRow("refs/heads/old")!);
  expect(get("status", /older than/).textContent).toBe(
    "old is older than the newest 6 loaded commits.",
  );
});

it("the unsaved conflict results list opens RetainedResolution, switching repository when needed", async () => {
  const app = await mountApp();
  await dirtyResolution(app, PIN_FEATURE, "here.txt");
  await dirtyResolution(app, OTHER, "there.txt");
  const list = document.querySelector(
    '[aria-label="Unsaved conflict results"]',
  )!;
  expect(
    queryAll("button", undefined, list).map((button) => button.textContent),
  ).toEqual(["here.txt", "there.txt"]);

  app.bridge.reset();
  await app.click(get("button", "here.txt"));
  expect(dialogs()).toEqual(["Unsaved resolution for here.txt"]);
  expect(
    app.bridge.count("snapshot"),
    "a worktree of the open repository",
  ).toBe(0);
  await app.press("Escape");
  expect(dialogs()).toEqual([]);

  app.bridge.reset();
  await app.click(get("button", "there.txt"));
  expect(app.bridge.lines((request) => request.op === "snapshot")).toEqual([
    "snapshot /fixture/other",
  ]);
  expect(dialogs()).toEqual(["Unsaved resolution for there.txt"]);
  expect(selectedRow()).toBe("Other tip, Pin Author, 8888888");
  expect(
    get("button", "Expand other"),
    "it opens the repository without expanding it in the sidebar",
  ).toBeTruthy();
});

it("notices keep their order above the panes", async () => {
  const app = await mountApp();
  await dirtyResolution(app, OTHER, "there.txt");
  await app.click(historyRow("Release,"));
  const setItem = localStorage.setItem.bind(localStorage);
  const spy = vi
    .spyOn(localStorage, "setItem")
    .mockImplementation((key: string, value: string) => {
      if (key === VISIBILITY_KEY) throw new Error("The quota is full.");
      setItem(key, value);
    });
  try {
    await app.click(get("button", "Hide topic"));
  } finally {
    spy.mockRestore();
  }
  await app.click(refRow("refs/heads/topic")!);
  app.bridge.fail("snapshot", {
    kind: "timedOut",
    message: "Reading this repository took too long.",
  });
  await app.refocusWindow();
  const content = document.querySelector(".repository-content")!;
  const rows = [
    ...content.querySelectorAll(
      ":scope > .notice, :scope > .resolution-draft-list, :scope > .merge-controls",
    ),
  ].map((row) => row.getAttribute("aria-label") ?? row.textContent);
  expect(rows).toMatchInlineSnapshot(`
    [
      "Branch merge",
      "Unsaved conflict results",
      "Hidden and soloed branches changed for this session. Could not save them.",
      "Reading this repository took too long. The last successful view is retained.Try again",
      "topic is hidden in the graph.Show topic",
    ]
  `);
});
