// @vitest-environment happy-dom
import { expect, it } from "vitest";
import type { Draft } from "./domain/drafts";
import type { PullRequest } from "./domain/pullRequest";
import { oidSchema } from "./domain/repository";
import { get, installHarness, query, queryAll } from "./test/appHarness";
import type { Harness } from "./test/appHarness";
import { pullKey } from "./test/fakeBridge";
import type { Bridge, World } from "./test/fakeBridge";
import { open, pull, refresh, tab, visit } from "./test/pullRequests";

installHarness();

const oid = (digit: string) => oidSchema.parse(digit.repeat(40));
const head = oid("1");
const book = "octo octo/pin#1";
const patch = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,3 +10,4 @@
 one
-two
+TWO
+and
 three
`;

function answer(bridge: Bridge) {
  bridge.respond("rangeFiles", () => ({
    kind: "ready",
    mergeBase: oid("a"),
    files: [
      {
        path: "src/a.ts",
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
      },
    ],
    contentMissing: false,
    shallow: false,
  }));
  bridge.respond("rangePatches", () => [
    { path: "src/a.ts", patch: { kind: "text", patch, lossy: false } },
  ]);
}

const draft = (line: number, text: string, fields: Partial<Draft> = {}) => ({
  anchor: {
    kind: "line" as const,
    path: "src/a.ts",
    side: "right" as const,
    line,
    start: null,
  },
  head,
  text,
  writtenAt: 1,
  savedAt: 1,
  mayHavePosted: false,
  ...fields,
});

async function openFiles({
  fields = {},
  world,
}: {
  fields?: Partial<PullRequest>;
  world?: (world: World) => void;
} = {}): Promise<Harness> {
  const app = await visit({
    bridge: answer,
    world: (each) => {
      each.host.details.set(pullKey("octo/pin", 1), pull(1, fields));
      world?.(each);
    },
  });
  await open(app, 1);
  await app.click(tab("Files changed"));
  return app;
}

const panel = () => get("tabpanel", /^Files changed/);
const diff = () => panel().querySelector("diffs-container")!.shadowRoot!;
const number = (line: number, type = "change-addition") =>
  diff().querySelector<HTMLElement>(
    `[data-column-number="${line}"][data-line-type="${type}"]`,
  )!;
const pointer = (target: EventTarget, kind: string, init: PointerEventInit) =>
  target.dispatchEvent(
    new PointerEvent(kind, {
      bubbles: true,
      composed: true,
      pointerType: "mouse",
      button: 0,
      pointerId: 1,
      ...init,
    }),
  );
/** A click on a line number, and a Shift-click on another to extend it. */
async function choose(app: Harness, from: number, to = from, type?: string) {
  await app.act(() => {
    pointer(number(from, type), "pointerdown", {});
    pointer(document, "pointerup", {});
  });
  if (to === from) return;
  await app.act(() => {
    pointer(number(to), "pointerdown", { shiftKey: true });
    pointer(document, "pointerup", {});
  });
}
const box = () => query("region", /^Comment on /);
const words = () => get("textbox", /^Comment on /) as HTMLTextAreaElement;
/** The pending comments, once their words are drawn. */
async function pending(app: Harness) {
  for (let frame = 0; frame < 5; frame += 1) await app.flushFrames();
  return queryAll("region", "Pending comment").map((each) => each.textContent);
}
const kept = (bridge: Bridge) =>
  (bridge.world.host.drafts.get(book) ?? []).map(({ text }) => text);
const writes = (bridge: Bridge) =>
  bridge.hostLog.filter(({ op }) => op === "write").length;

it("opens a box under chosen lines, and keeps its words as a pending comment", async () => {
  const app = await openFiles();
  await choose(app, 11, 12);
  expect(box()?.getAttribute("aria-label")).toBe("Comment on lines 11–12");
  expect(box()?.textContent).toContain("Saved as a draft on this machine");
  expect(get("button", "Start a review").getAttribute("aria-disabled")).toBe(
    "true",
  );
  await app.type(words(), "Should **and** be here?");
  await app.click(get("tab", "Preview"));
  for (let frame = 0; frame < 5; frame += 1) await app.flushFrames();
  expect(box()?.querySelector("strong")?.textContent).toBe("and");
  await app.click(get("tab", "Write"));
  await app.click(get("button", "Start a review"));
  expect(box()).toBeNull();
  expect(await pending(app)).toEqual([
    "OYou on lines 11–12PendingEditDeleteShould and be here?",
  ]);
  expect(kept(app.bridge)).toEqual(["Should **and** be here?"]);
  expect(writes(app.bridge), "a review starts on this computer").toBe(0);

  await choose(app, 13, 13, "context");
  expect(box()?.getAttribute("aria-label")).toBe("Comment on line 13");
  expect(get("button", "Add review comment")).toBeTruthy();
});

it("keeps pending comments for the next time, and edits and deletes them", async () => {
  const app = await openFiles({
    world: (world) =>
      world.host.drafts.set(book, [draft(12, "Is this right?")]),
  });
  expect(await pending(app)).toEqual([
    "OYou on line 12PendingEditDeleteIs this right?",
  ]);
  await app.click(get("button", "Edit"));
  expect(words().value).toBe("Is this right?");
  await app.type(words(), "Is this wrong?");
  await app.click(get("button", "Cancel"));
  expect(await pending(app)).toEqual([
    "OYou on line 12PendingEditDeleteIs this right?",
  ]);
  await app.click(get("button", "Edit"));
  await app.type(words(), "Is this wrong?");
  await app.click(get("button", "Update comment"));
  expect(kept(app.bridge)).toEqual(["Is this wrong?"]);
  await app.click(get("button", "Delete"));
  expect(await pending(app)).toEqual([]);
  expect(kept(app.bridge)).toEqual([]);
});

it("adds a single comment once, on your own pull request too", async () => {
  const app = await openFiles({
    fields: { viewerIsAuthor: true, author: "octo" },
  });
  await choose(app, 11, 12);
  await app.type(words(), "Name it better.");
  const held = app.bridge.hold("write");
  await app.click(get("button", "Add single comment"));
  expect(words().readOnly, "the words wait for GitHub's answer").toBe(true);
  expect(box()?.getAttribute("aria-busy")).toBe("true");
  expect(get("status", "Sending…")).toBeTruthy();
  await app.click(get("button", "Add single comment"));
  held.release();
  await app.settle();
  expect(app.bridge.world.host.mutations).toEqual([
    {
      kind: "singleComment",
      pull: "PR_1",
      commit: head,
      lines: {
        path: "src/a.ts",
        side: "right",
        line: 12,
        start: { side: "right", line: 11 },
      },
      body: "Name it better.",
    },
  ]);
  expect(box()).toBeNull();
  expect(kept(app.bridge)).toEqual([]);
  await app.click(refresh());
  expect(queryAll("region", "Single comment")).toEqual([]);
  expect(panel().textContent).toContain("Name it better.");
});

it("gives the words back when GitHub refuses, and says why", async () => {
  const app = await openFiles({
    world: (world) => {
      world.host.writes = [
        {
          kind: "refused",
          message: "GitHub didn't do it: Line 12 isn't in the diff.",
        },
      ];
    },
  });
  await choose(app, 12);
  await app.type(words(), "Hm.");
  await app.click(get("button", "Add single comment"));
  expect(box()?.querySelector("[role=alert]")?.textContent).toBe(
    "GitHub didn't do it: Line 12 isn't in the diff.",
  );
  expect(words().readOnly).toBe(false);
  expect(words().value).toBe("Hm.");
  expect(app.bridge.world.host.mutations).toEqual([]);
});

it("offers three choices when a comment may have posted, and never sends it again by itself", async () => {
  const app = await openFiles({
    world: (world) => {
      world.host.writes = [{ kind: "unknown", applied: false }];
    },
  });
  await choose(app, 12);
  await app.type(words(), "Maybe.");
  await app.click(get("button", "Add single comment"));
  expect(box()?.textContent).toContain("may have posted");
  expect(get("link", "Open on GitHub", box()!).getAttribute("href")).toBe(
    "https://github.com/octo/pin/pull/1/files",
  );
  await app.click(refresh());
  expect(app.bridge.world.host.mutations).toHaveLength(1);
  await app.click(get("button", "Keep as draft"));
  expect(words().readOnly).toBe(false);
  expect(words().value).toBe("Maybe.");
  expect(box()?.textContent).toContain("it may have posted");
  expect(app.bridge.world.host.mutations).toHaveLength(1);
});

it("sends a comment that may have posted again only on Send anyway", async () => {
  const app = await openFiles({
    world: (world) => {
      world.host.writes = [{ kind: "unknown", applied: false }];
    },
  });
  await choose(app, 12);
  await app.type(words(), "Again?");
  await app.click(get("button", "Add single comment"));
  await app.click(get("button", "Send anyway"));
  expect(app.bridge.world.host.mutations).toHaveLength(2);
  expect(box()).toBeNull();
});

it("shows a pending comment of an earlier commit with the file's other comments, never on a line", async () => {
  const app = await openFiles({
    world: (world) =>
      world.host.drafts.set(book, [draft(12, "Old words", { head: oid("0") })]),
  });
  expect(await pending(app)).toEqual([]);
  await app.click(get("button", "1 comment that isn't on a line here"));
  expect(await pending(app)).toEqual([
    "OYou on line 12PendingWritten against an earlier commitDeleteOld words",
  ]);
});

it("keeps the box and its words while threads come", async () => {
  const app = await openFiles();
  await choose(app, 12);
  await app.type(words(), "Typing");
  const typed = words();
  typed.focus();
  const { details } = app.bridge.world.host;
  details.set(
    pullKey("octo/pin", 1),
    pull(1, {
      threads: {
        items: [
          {
            id: "T9",
            review: null,
            path: "src/a.ts",
            line: 11,
            startLine: null,
            originalLine: 11,
            originalStartLine: null,
            side: "right",
            outdated: false,
            resolved: false,
            hunk: "",
            can: { reply: true, resolve: true, unresolve: false },
            comments: {
              items: [
                {
                  id: "C9",
                  by: "sara",
                  at: "2026-11-26T10:00:00Z",
                  body: "Hi",
                },
              ],
              total: 1,
            },
          },
        ],
        total: 1,
      },
    }),
  );
  await app.click(refresh());
  typed.focus();
  expect(words()).toBe(typed);
  expect(words().value).toBe("Typing");
  await app.click(get("button", "Start a review"));
  expect(panel().textContent).toContain("Hi");
});

it("comments on the change the view is at with C", async () => {
  const app = await openFiles();
  await app.press("c");
  expect(box()?.getAttribute("aria-label")).toBe("Comment on lines 11–12");
  expect(document.activeElement).toBe(words());
});

it("comments on lines in All files too", async () => {
  const app = await openFiles();
  await app.click(get("button", "All files"));
  for (let frame = 0; frame < 5; frame += 1) await app.flushFrames();
  await choose(app, 12);
  await app.type(words(), "Here as well");
  await app.click(get("button", "Start a review"));
  expect(await pending(app)).toEqual([
    "OYou on line 12PendingEditDeleteHere as well",
  ]);
});
