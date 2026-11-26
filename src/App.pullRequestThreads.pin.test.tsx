// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import type { ReviewThread } from "./domain/pullRequest";
import type { RangeFile } from "./domain/range";
import { oidSchema } from "./domain/repository";
import { get, installHarness, query, queryAll } from "./test/appHarness";
import type { Harness } from "./test/appHarness";
import { pullKey } from "./test/fakeBridge";
import type { Bridge, World } from "./test/fakeBridge";
import { at, open, page, pull, tab, visit } from "./test/pullRequests";

installHarness();

const said = (id: string, by: string, body: string, hour = 3) => ({
  id,
  by,
  body,
  at: at(hour),
});
const thread = (
  id: string,
  path: string,
  fields: Partial<ReviewThread> = {},
): ReviewThread => ({
  id,
  review: null,
  path,
  line: 3,
  startLine: null,
  originalLine: 3,
  originalStartLine: null,
  side: "right",
  outdated: false,
  resolved: false,
  hunk: "",
  can: { reply: true, resolve: true, unresolve: false },
  comments: page([said(`${id}-1`, "sara", `Says ${id}`)]),
  ...fields,
});
const threads = [
  thread("T1", "src/a.ts", { line: 9 }),
  thread("T2", "src/a.ts", {
    line: 1,
    comments: page([
      said("T2-1", "octo", "Does this run on every render?", 2),
      said("T2-2", "maja", "Moved it. Does this work?", 4),
    ]),
  }),
  thread("T3", "src/b.ts", { line: null, originalLine: 5, outdated: true }),
  thread("T4", "src/a.ts", { resolved: true }),
  thread("T5", "src/c.ts", {
    resolved: true,
    can: { reply: true, resolve: false, unresolve: true },
  }),
];
const world = (world: World) =>
  world.host.details.set(
    pullKey("octo/pin", 1),
    pull(1, { threads: page(threads) }),
  );

const oid = (digit: string) => oidSchema.parse(digit.repeat(40));
const file = (path: string): RangeFile => ({
  path,
  status: "M",
  from: null,
  similarity: null,
  added: 1,
  deleted: 1,
  oldBlob: oid("1"),
  newBlob: oid("2"),
  oldMode: "100644",
  newMode: "100644",
  submodule: false,
});
function answer(bridge: Bridge) {
  const files = ["src/a.ts", "src/b.ts", "src/c.ts"].map(file);
  bridge.respond("rangeFiles", () => ({
    kind: "ready",
    mergeBase: oid("a"),
    files,
    contentMissing: false,
    shallow: false,
  }));
  bridge.respond("rangePatches", () =>
    files.map(({ path }) => ({
      path,
      patch: {
        kind: "text",
        patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,2 +1,2 @@\n-one\n+ONE\n two\n`,
        lossy: false,
      },
    })),
  );
}

async function threadsOf(app: Harness) {
  await open(app, 1);
  await app.click(get("button", /^Threads/));
}
const filter = (name: string) =>
  get("button", new RegExp(`^${name}\\d`), get("group", "Show threads"));
const shown = () =>
  queryAll("region").flatMap((section) =>
    section.classList.contains("threads-file")
      ? [
          [
            section.getAttribute("aria-label"),
            ...[...section.querySelectorAll(".threads-row-head")].map(
              (row) => row.textContent,
            ),
          ],
        ]
      : [],
  );
const row = (words: string) => get("button", new RegExp(words));

it("lists every thread by file, one row each, with a count for each filter", async () => {
  const app = await visit({ world });
  await threadsOf(app);
  expect(get("button", /^Threads/).textContent).toBe("Threads 3 open");
  expect(
    queryAll("button", undefined, get("group", "Show threads")).map(
      (button) => [button.textContent, button.getAttribute("aria-pressed")],
    ),
  ).toEqual([
    ["Open3", "true"],
    ["Waiting on you1", "false"],
    ["Outdated1", "false"],
    ["Resolved2", "false"],
  ]);
  expect(shown()).toEqual([
    [
      "src/a.ts",
      expect.stringMatching(
        /^:1OYouDoes this run on every render\?1 reply1Waiting on you\d/,
      ),
      expect.stringMatching(/^:9SsaraSays T1Open\d/),
    ],
    ["src/b.ts", expect.stringMatching(/^:5SsaraSays T3Outdated\d/)],
  ]);
  expect(document.querySelector(".threads-hidden")?.textContent).toBe(
    "2 resolved threads are hidden.Show them",
  );

  await app.click(filter("Waiting on you"));
  expect(shown()).toEqual([["src/a.ts", expect.stringMatching(/^:1OYou/)]]);
  await app.click(filter("Open"));
  await app.click(get("button", "Show them"));
  expect(filter("Resolved").getAttribute("aria-pressed")).toBe("true");
  expect(shown().map(([path]) => path)).toEqual(["src/a.ts", "src/c.ts"]);
  expect(app.bridge.world.host.mutations).toEqual([]);
});

it("opens a row to its comments, Reply, Show in diff and Resolve, and keeps it folded in place once resolved", async () => {
  const app = await visit({ world });
  await threadsOf(app);
  const head = row("Says T1");
  expect(head.getAttribute("aria-expanded")).toBe("false");
  await app.click(head);
  for (let frame = 0; frame < 5; frame += 1) await app.flushFrames();
  const body = document.getElementById(head.getAttribute("aria-controls")!)!;
  expect(body.textContent).toContain("Says T1");
  expect(
    queryAll("button", undefined, body).map((button) => button.textContent),
  ).toEqual(["Reply…", "Show in diff", "Resolve"]);

  const resolve = get("button", "Resolve", body);
  resolve.focus();
  await app.click(resolve);
  await vi.waitFor(() =>
    expect(row("Says T1").textContent).toContain("Resolved"),
  );
  expect(app.bridge.world.host.mutations).toEqual([
    { kind: "resolve", thread: "T1" },
  ]);
  expect(row("Says T1").getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(row("Says T1"));
  expect(filter("Open").textContent).toBe("Open2");
  await app.click(filter("Outdated"));
  expect(query("button", /Says T1/)).toBeNull();
});

it("shows a thread's file in Files changed", async () => {
  const app = await visit({ world, bridge: answer });
  await threadsOf(app);
  await app.click(row("Says T3"));
  await app.click(get("button", "Show in diff"));
  expect(tab("Files changed").getAttribute("aria-selected")).toBe("true");
  await vi.waitFor(() =>
    expect(document.querySelector(".file-diff-path")?.textContent).toBe(
      "src/b.ts",
    ),
  );
  expect(document.querySelector(".files-position")?.textContent).toBe("2 of 3");
});

it("shows a thread on its line in Files changed, open, where Reply and Resolve write too", async () => {
  const app = await visit({ world, bridge: answer });
  await threadsOf(app);
  await app.click(row("Does this run on every render"));
  await app.click(get("button", "Show in diff"));
  expect(tab("Files changed").getAttribute("aria-selected")).toBe("true");
  const chip = () =>
    queryAll("region", "Thread").find((each) =>
      each.textContent.includes("Moved it."),
    );
  // Pierre draws the line's threads a few frames after the file.
  for (let frame = 0; frame < 20 && !chip(); frame += 1)
    await app.flushFrames();
  expect(document.querySelector(".file-diff-path")?.textContent).toBe(
    "src/a.ts",
  );
  expect(
    get("button", /2 comments/, chip()).getAttribute("aria-expanded"),
    "the thread is open on its line",
  ).toBe("true");
  expect(
    queryAll("button", undefined, chip()).map((button) => button.textContent),
  ).toEqual([expect.stringMatching(/2 comments/), "Reply…", "Resolve"]);

  await app.click(get("button", "Reply…", chip()));
  await app.type(get("textbox", "Reply", chip()), "Yes, it works.");
  await app.click(get("button", "Reply", chip()));
  await vi.waitFor(() =>
    expect(app.bridge.world.host.mutations).toEqual([
      { kind: "reply", thread: "T2", body: "Yes, it works." },
    ]),
  );
});

it("says when GitHub left the threads out", async () => {
  const app = await visit({
    world: ({ host }) =>
      host.details.set(pullKey("octo/pin", 1), pull(1, { threads: null })),
  });
  await threadsOf(app);
  expect(query("group", "Show threads")).toBeNull();
  expect(document.querySelector(".threads-note")?.textContent).toBe(
    "Review threads didn't load. GitHub couldn't answer for a pull request this large.",
  );
});
