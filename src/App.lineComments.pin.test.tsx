// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { get, installHarness } from "./test/appHarness";
import { pullKey } from "./test/fakeBridge";
import {
  book,
  box,
  choose,
  draft,
  kept,
  oid,
  oneFile,
  openFiles,
  panel,
  pending,
  words,
  writes,
} from "./test/lineComments";
import { open, pull, refresh, tab, visit } from "./test/pullRequests";

installHarness();

it("opens a box under chosen lines, and keeps its words as a pending comment", async () => {
  const app = await openFiles();
  await choose(app, 11, 12);
  expect(box()?.getAttribute("aria-label")).toBe("Comment on lines 11–12");
  // As a click on a line number does, after the box mounts.
  panel().querySelector<HTMLElement>(".file-diff-scroll")!.focus();
  await app.flushFrames();
  expect(document.activeElement, "the words take the focus").toBe(words());
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
  await choose(app, 11, 12);
  panel().querySelector<HTMLElement>(".file-diff-scroll")!.focus();
  await app.flushFrames();
  expect(document.activeElement, "the words take it where the box moves").toBe(
    words(),
  );
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

it("opens no box before the saved comments are read, so Cancel never deletes one it didn't make", async () => {
  const app = await visit({
    bridge: oneFile,
    world: (world) => {
      world.host.details.set(pullKey("octo/pin", 1), pull(1));
      world.host.drafts.set(book, [draft(12, "Is this right?")]);
    },
  });
  const reading = app.bridge.hold("drafts");
  await open(app, 1);
  await app.click(tab("Files changed"));
  await reading.arrived;
  await choose(app, 12);
  expect(box()).toBeNull();
  expect(panel().textContent).toContain(
    "Reading your saved comments. Choose the lines again in a moment.",
  );
  reading.release();
  await app.settle();
  await choose(app, 12);
  expect(words().value).toBe("Is this right?");
  await app.click(get("button", "Cancel"));
  expect(await pending(app)).toEqual([
    "OYou on line 12PendingEditDeleteIs this right?",
  ]);
  expect(kept(app.bridge)).toEqual(["Is this right?"]);
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
  await app.flushFrames();
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

it("keeps the box where its words are when other lines are chosen, until they are finished or cancelled", async () => {
  const app = await openFiles({
    world: (world) => world.host.drafts.set(book, [draft(11, "Kept")]),
  });
  await choose(app, 12);
  await app.type(words(), "Half a thought");
  await choose(app, 13, 13, "context");
  expect(box()?.getAttribute("aria-label")).toBe("Comment on line 12");
  expect(words().value).toBe("Half a thought");
  expect(box()?.textContent).toContain("Finish or cancel this comment first.");
  await app.flushFrames();
  expect(document.activeElement, "the words take the focus").toBe(words());
  expect(await pending(app), "its words don't become pending").toEqual([
    "OYou on line 11PendingEditDeleteKept",
  ]);
  await app.click(get("button", "Cancel"));
  await choose(app, 13, 13, "context");
  expect(box()?.getAttribute("aria-label")).toBe("Comment on line 13");

  await app.click(get("button", "Cancel"));
  await app.click(get("button", "Edit"));
  await choose(app, 13, 13, "context");
  expect(
    box()?.getAttribute("aria-label"),
    "an edit with its words as they were moves",
  ).toBe("Comment on line 13");
  await app.click(get("button", "Cancel"));
  await app.click(get("button", "Edit"));
  await app.type(words(), "Kept, and changed");
  await choose(app, 13, 13, "context");
  expect(box()?.getAttribute("aria-label")).toBe("Comment on line 11");
  expect(box()?.textContent).toContain("Finish or cancel this comment first.");
  expect(app.bridge.world.host.mutations).toEqual([]);
});

it("keeps a comment pending with Cmd or Ctrl+Enter, as the box's main button does", async () => {
  const app = await openFiles();
  await choose(app, 12);
  await app.type(words(), "By keys");
  await app.press("Enter", { target: words(), ctrlKey: true });
  expect(box()).toBeNull();
  await choose(app, 13, 13, "context");
  await app.type(words(), "And more");
  await app.press("Enter", { target: words(), metaKey: true });
  expect(await pending(app)).toEqual([
    "OYou on line 12PendingEditDeleteBy keys",
    "OYou on line 13PendingEditDeleteAnd more",
  ]);
  expect(app.bridge.world.host.mutations).toEqual([]);
});

it("gives the focus to the pending comment Start a review keeps, and to the words when a message goes", async () => {
  const app = await openFiles({
    world: (world) => {
      world.host.writes = [{ kind: "refused", message: "GitHub said no." }];
    },
  });
  await choose(app, 12);
  await app.type(words(), "Focus here");
  await app.click(get("button", "Add single comment"));
  await app.click(get("button", "Dismiss", box()!));
  expect(document.activeElement, "the words, not the page").toBe(words());
  await app.click(get("button", "Start a review"));
  await pending(app);
  expect(document.activeElement).toBe(get("region", "Pending comment"));
});
