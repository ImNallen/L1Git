// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { get, installHarness, queryAll } from "./test/appHarness";
import { pullKey } from "./test/fakeBridge";
import {
  book,
  box,
  choose,
  draft,
  head,
  kept,
  openFiles,
  panel,
  pending,
  words,
} from "./test/lineComments";
import { refresh } from "./test/pullRequests";

installHarness();

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
  expect(box()?.textContent, "its words are not a draft now").not.toContain(
    "Saved as a draft",
  );
  expect(get("link", "Open on GitHub", box()!).getAttribute("href")).toBe(
    "https://github.com/octo/pin/pull/1/files",
  );
  expect(box()?.textContent).toContain("Send anyway may post it twice.");
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

it("shows a comment on its way once, from its own card, when the box moves on", async () => {
  const app = await openFiles();
  await choose(app, 12);
  await app.type(words(), "On its way");
  const held = app.bridge.hold("write");
  await app.click(get("button", "Add single comment"));
  await choose(app, 13, 13, "context");
  expect(await pending(app), "its words are not pending now").toEqual([]);
  expect(get("region", "Single comment").textContent).toContain("Sending…");
  held.release();
  await app.settle();
  expect(app.bridge.world.host.mutations).toHaveLength(1);
});

it("reads only where another write carries the words, until it ends", async () => {
  const carried = draft(12, "Sent with the review");
  const lines = {
    path: "src/a.ts",
    side: "right" as const,
    line: 12,
    start: null,
  };
  const review = {
    kind: "submitReview" as const,
    pull: "PR_1" as never,
    commit: head,
    event: "comment" as const,
    body: "",
    threads: [{ lines, body: carried.text }],
  };
  const app = await openFiles({
    world: (world) =>
      world.host.sent.set(book, [
        {
          attempt: "elsewhere",
          at: 1,
          write: review,
          drafts: [carried],
          sending: true,
          applied: false,
        },
      ]),
  });
  await choose(app, 12);
  expect(words().readOnly).toBe(true);
  expect(words().value).toBe("Sent with the review");
  expect(get("status", "Sending…", box()!)).toBeTruthy();
  expect(box()?.textContent).toContain("You can change them once it ends.");
  expect(
    get("button", "Add single comment").getAttribute("aria-disabled"),
  ).toBe("true");
  await app.click(get("button", "Cancel"));
  expect(box()).toBeNull();
  expect(kept(app.bridge)).toEqual([]);
  expect(app.bridge.world.host.mutations).toEqual([]);
});

it("keeps a comment's may have posted choices in the box when Send anyway sends nothing", async () => {
  const app = await openFiles({
    world: (world) => {
      world.host.writes = [
        { kind: "unknown", applied: false },
        {
          kind: "notSent",
          message:
            "L1 Git could not read the pull request first, so it sent nothing.",
        },
      ];
    },
  });
  await choose(app, 12);
  await app.type(words(), "Twice?");
  await app.click(get("button", "Add single comment"));
  await app.click(get("button", "Send anyway"));
  expect(box()?.textContent).toContain("could not read the pull request");
  expect(box()?.textContent).toContain("May have posted");
  expect(get("button", "Keep as draft", box()!)).toBeTruthy();
  expect(get("button", "Send anyway", box()!)).toBeTruthy();
  expect(words().readOnly).toBe(true);
  expect(app.bridge.world.host.mutations).toHaveLength(1);
});

it("says so in the box when Send anyway or Keep as draft does nothing", async () => {
  const app = await openFiles({
    world: (world) => {
      world.host.writes = [{ kind: "unknown", applied: false }];
    },
  });
  await choose(app, 12);
  await app.type(words(), "Stuck?");
  await app.click(get("button", "Add single comment"));
  const { draftImpact, freezeDrafts } = app.modules.draftProtection;
  const frozen = freezeDrafts(draftImpact().revision);
  await app.click(get("button", "Send anyway"));
  expect(box()?.textContent).toContain(
    "L1 Git is restarting to update, so it sent nothing.",
  );
  if (frozen.kind === "frozen") frozen.release();
  const failing = app.bridge.failHost(
    { kind: "unreachable", message: "L1 Git could not reach GitHub." },
    pullKey("octo/pin", 1),
  );
  await app.click(get("button", "Keep as draft"));
  expect(box()?.textContent).toContain(
    "L1 Git couldn't keep it as a draft, so nothing changed.",
  );
  expect(get("button", "Send anyway", box()!)).toBeTruthy();
  failing();
  expect(app.bridge.world.host.mutations).toHaveLength(1);
});

it("gives a box opened while a single comment saves none of that comment's sending", async () => {
  const app = await openFiles();
  await choose(app, 12);
  await app.type(words(), "Saved first");
  const saving = app.bridge.hold("drafts");
  await app.click(get("button", "Add single comment"));
  await saving.arrived;
  await choose(app, 13, 13, "context");
  saving.release();
  await app.settle();
  expect(box()?.getAttribute("aria-label")).toBe("Comment on line 13");
  expect(words().readOnly).toBe(false);
  expect(words().value).toBe("");
  expect(box()?.textContent).not.toContain("Sending…");
  await app.click(get("button", "Cancel"));
  expect(panel().textContent).toContain("Saved first");
  expect(app.bridge.world.host.mutations).toHaveLength(1);
});
