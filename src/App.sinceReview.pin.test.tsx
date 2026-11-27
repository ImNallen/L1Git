// @vitest-environment happy-dom
import { expect, it } from "vitest";
import type { PullRequest, ReviewThread } from "./domain/pullRequest";
import type { RangeFile } from "./domain/range";
import { get, installHarness, query } from "./test/appHarness";
import type { Harness } from "./test/appHarness";
import { pullKey } from "./test/fakeBridge";
import type { Bridge } from "./test/fakeBridge";
import { box, choose, head, oid, words } from "./test/lineComments";
import {
  at,
  open,
  page,
  pull as anyPull,
  tab,
  visit,
} from "./test/pullRequests";

installHarness();

const replayed = oid("5");
const reviewed = { oid: oid("e"), at: at(3) };
const file = (path: string, fields: Partial<RangeFile> = {}): RangeFile => ({
  path,
  status: "M",
  from: null,
  similarity: null,
  added: 2,
  deleted: 1,
  oldBlob: oid("1"),
  newBlob: oid("2"),
  oldMode: "100644",
  newMode: "100644",
  submodule: false,
  ...fields,
});
/** The pull request now: a.ts the author changed again, b.ts only the rebase moved, c.ts and d.ts as reviewed. */
const now = [
  file("src/a.ts", { newBlob: oid("3") }),
  file("src/b.ts", { oldBlob: oid("4"), newBlob: oid("6") }),
  file("src/c.ts"),
  file("src/d.ts"),
];
const asReviewed = [file("src/a.ts"), file("src/b.ts"), now[2]!, now[3]!];
const since = [file("src/a.ts", { added: 1, deleted: 1 })];
const own = (path: string) =>
  path === "src/a.ts"
    ? "@@ -10,3 +10,4 @@\n one\n-two\n+TWO\n+AND\n three\n"
    : "@@ -1,1 +1,1 @@\n-x\n+y\n";
const patchOf = (path: string, lines: string) => ({
  path,
  patch: {
    kind: "text",
    patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${lines}`,
    lossy: false,
  },
});
const rebased = {
  id: "F1",
  kind: "forcePushed" as const,
  from: oid("e"),
  to: head,
  by: "maja",
  at: at(4),
};
const pull = (fields: Partial<PullRequest> = {}) =>
  anyPull(1, {
    changedFiles: 4,
    additions: 8,
    deletions: 4,
    reviewed,
    timeline: page([rebased]),
    ...fields,
  });

function answer(bridge: Bridge) {
  bridge.respond("rangeFiles", () => ({
    kind: "ready",
    mergeBase: oid("a"),
    files: now,
    contentMissing: false,
    shallow: false,
  }));
  bridge.respond("sinceReview", () => ({
    kind: "ready",
    since: replayed,
    fromBase: { kind: "leftOut" },
    reviewed: asReviewed,
    files: since,
    contentMissing: false,
  }));
  bridge.respond("rangePatches", (request) =>
    request.mergeBase === replayed
      ? [
          patchOf(
            "src/a.ts",
            "@@ -10,4 +10,4 @@\n one\n TWO\n-and\n+AND\n three\n",
          ),
        ]
      : now.map(({ path }) => patchOf(path, own(path))),
  );
}

async function openFiles(
  fields: Partial<PullRequest> = {},
  more: (bridge: Bridge) => void = () => {},
  view: "one" | "all" = "one",
): Promise<Harness> {
  const app = await visit({
    stored: {
      "l1git.filesChanged.v1": JSON.stringify({
        version: 1,
        diffStyle: "unified",
        view,
      }),
    },
    bridge: (bridge) => {
      answer(bridge);
      more(bridge);
    },
    world: (world) => {
      world.host.details.set(pullKey("octo/pin", 1), pull(fields));
    },
  });
  await open(app, 1);
  await app.click(tab("Files changed"));
  await frames(app);
  return app;
}
async function frames(app: Harness) {
  for (let frame = 0; frame < 5; frame += 1) await app.flushFrames();
}
const panel = () => get("tabpanel", /^Files changed/);
const place = () => document.querySelector(".files-position")?.textContent;
const path = () =>
  document.querySelector(".files-toolbar .file-diff-path")?.textContent;
const toggle = (name: RegExp) => get("button", name, panel());
const notice = () =>
  panel().querySelector(".since-notice, .since-stopped")?.textContent ?? null;
const chips = () =>
  [...document.querySelectorAll(".thread-chip-row")].map(
    (row) => row.textContent,
  );

it("opens at what changed since your review, and shows all changes in one click", async () => {
  const app = await openFiles();
  expect(tab("Files changed").textContent).toBe("Files changed1 new");
  expect(toggle(/^Since your last review/).textContent).toBe(
    "Since your last review1",
  );
  expect(toggle(/^Since your last review/).getAttribute("aria-pressed")).toBe(
    "true",
  );
  expect(panel().querySelector(".since-reviewed")?.textContent).toMatch(
    /^OYou reviewed eeeeeee .+ ago\.$/,
  );
  expect(place()).toBe("1 of 1");
  expect(path()).toBe("src/a.ts");
  expect(
    get("complementary", "Pull request details").querySelector(
      ".files-section h3",
    )?.textContent,
  ).toBe("Since your last review1 of 4+1−1");
  expect(panel().querySelector(".files-toolbar")?.textContent).toContain(
    "+1−1since your review",
  );
  expect(panel().querySelector(".files-next")?.textContent).toContain(
    "That's everything new in this file.",
  );
  expect(app.bridge.log.filter(({ op }) => op === "sinceReview")).toMatchObject(
    [{ base: "b".repeat(40), reviewed: oid("e"), head }],
  );

  await app.click(toggle(/^All changes/));
  expect(place(), "at the same file").toBe("1 of 4");
  expect(path()).toBe("src/a.ts");
  expect(panel().querySelector(".files-next")?.textContent).not.toContain(
    "everything new",
  );
  await app.click(toggle(/^Since your last review/));
  expect(place()).toBe("1 of 1");
});

it("shows what changed since your review in All files too", async () => {
  const app = await openFiles({}, () => {}, "all");
  const headers = () =>
    [...panel().querySelectorAll("diffs-container")].map(
      (each) =>
        each.shadowRoot?.querySelector(".files-header")?.textContent ??
        each.querySelector(".files-header")?.textContent,
    );
  expect(panel().querySelector(".files-all")?.textContent).toContain("1 file");
  expect(headers().join()).toContain("src/a.ts+1−1since your review");
  await app.click(get("button", "Show them"));
  await frames(app);
  expect(panel().querySelector(".files-all")?.textContent).toContain("2 files");
});

it("shows the files main alone changed when asked", async () => {
  const app = await openFiles();
  expect(notice()).toBe(
    "maja rebased onto main after your review. 1 file changed only because of main, so it's hidden.Show them",
  );
  await app.click(get("button", "Show them"));
  expect(place()).toBe("1 of 2");
  expect(notice()).toBe(
    "maja rebased onto main after your review. 1 file changed only because of main, listed after the others.Hide them",
  );
  await app.press("j");
  expect(path()).toBe("src/b.ts");
  expect(panel().querySelector(".files-toolbar")?.textContent).not.toContain(
    "since your review",
  );
  await app.click(get("button", "Hide them"));
  expect(place()).toBe("1 of 1");
});

it("shows all changes, and says why, when the commit you reviewed can't be had", async () => {
  const app = await openFiles({}, (bridge) => {
    bridge.respond("sinceReview", () => ({
      kind: "missing",
      oids: [oid("e")],
    }));
    bridge.respond("fetchCommits", () => ({ kind: "noRemote" }));
  });
  expect(notice()).toBe(
    "Couldn't get eeeeeee, the commit you reviewed, so this shows all changes. This clone has no remote for octo/pin.Retry",
  );
  expect(place()).toBe("1 of 4");
  expect(
    app.bridge.log.filter(({ op }) => op === "fetchCommits"),
  ).toMatchObject([{ oids: [oid("e")] }]);
  expect(query("button", /^Since your last review/)).toBeNull();
  expect(tab("Files changed").textContent).toBe("Files changed4");

  const gone = await openFiles({ reviewed: { oid: null, at: at(3) } });
  expect(notice()).toBe(
    "Your review was of a commit GitHub no longer has, so this shows all changes.",
  );
  expect(place()).toBe("1 of 4");
  expect(
    gone.bridge.log.filter(({ op }) => op === "sinceReview"),
    "no Git call",
  ).toEqual([]);
});

it("comments on a new line at the head's line number, and on no old one", async () => {
  const app = await openFiles();
  await choose(app, 12, 12, "change-deletion");
  expect(box()).toBeNull();
  expect(panel().textContent).toContain(
    "In Since your last review, comments go on new lines. Switch to All changes to comment on old ones.",
  );
  await choose(app, 12);
  await app.type(words(), "Why upper case?");
  await app.click(get("button", "Add single comment"));
  await app.settle();
  expect(app.bridge.world.host.mutations).toEqual([
    {
      kind: "singleComment",
      pull: "PR_1",
      commit: head,
      lines: { path: "src/a.ts", side: "right", line: 12, start: null },
      body: "Why upper case?",
    },
  ]);
});

const thread = (id: string, fields: Partial<ReviewThread>): ReviewThread => ({
  id,
  review: null,
  path: "src/a.ts",
  line: 12,
  startLine: null,
  originalLine: 12,
  originalStartLine: null,
  side: "right",
  outdated: false,
  resolved: false,
  hunk: "",
  can: { reply: true, resolve: true, unresolve: false },
  comments: page([
    { id: `${id}-1`, by: "sara", at: at(2), body: `Says ${id}` },
  ]),
  ...fields,
});

it("places a right-side thread on its line, and a left-side one above the diff", async () => {
  const app = await openFiles({
    threads: page([
      thread("new", {}),
      thread("old", { side: "left", line: 11 }),
    ]),
  });
  expect(chips()).toEqual(["S1 commentsara: “Says new”"]);
  expect(get("button", "1 comment that isn't on a line here")).toBeTruthy();
  await app.click(toggle(/^All changes/));
  await frames(app);
  expect(chips(), "both have lines in All changes").toEqual([
    "S1 commentsara: “Says new”",
    "S1 commentsara: “Says old”",
  ]);
});

it("shows a thread on an old line in All changes, where its line is drawn", async () => {
  const app = await openFiles({
    threads: page([thread("old", { side: "left", line: 11 })]),
  });
  expect(place()).toBe("1 of 1");
  await app.click(tab("Conversation"));
  await app.click(get("button", /^Threads/));
  await app.click(get("button", /Says old/));
  await app.click(get("button", "Show in diff"));
  await frames(app);
  expect(toggle(/^All changes/).getAttribute("aria-pressed")).toBe("true");
  expect(place()).toBe("1 of 4");
  expect(chips()).toEqual(["S1 commentsara: “Says old”"]);
});
