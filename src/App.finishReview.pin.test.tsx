// @vitest-environment happy-dom
import { expect, it } from "vitest";
import type { PullRequest } from "./domain/pullRequest";
import { focused, get, installHarness } from "./test/appHarness";
import {
  draft,
  finish,
  head,
  kept,
  mutations,
  oid,
  openFiles,
  openPopover,
  panel,
  popover,
  submit,
  thread,
} from "./test/finishReview";
import { page } from "./test/pullRequests";

installHarness();

it("counts the pending comments, and sends them with the summary in one review", async () => {
  const app = await openFiles({
    drafts: [
      draft(11, "First thought"),
      draft(12, "Second one"),
      draft(12, "Of an older head", { head: oid("0") }),
    ],
  });
  expect(finish().textContent).toBe("Finish review · 2");
  const shown = await openPopover(app);
  expect(get("region", "2 pending comments", shown).textContent).toBe(
    "2 pending commentsa.ts:11First thoughta.ts:12Second one",
  );
  expect(
    get("region", "Written against an earlier commit", shown).textContent,
  ).toContain("a.ts:12Of an older headOpen at that lineDelete");
  expect(document.activeElement).toBe(get("textbox", "Summary", shown));
  await app.type(get("textbox", "Summary", shown), "Looks good.");
  await app.click(get("radio", /^Approve/, shown));
  await app.press("Enter", { metaKey: true });
  expect(mutations(app)).toEqual([
    {
      kind: "submitReview",
      pull: "PR_1",
      commit: head,
      event: "approve",
      body: "Looks good.",
      threads: [
        {
          lines: { path: "src/a.ts", side: "right", line: 11, start: null },
          body: "First thought",
        },
        {
          lines: { path: "src/a.ts", side: "right", line: 12, start: null },
          body: "Second one",
        },
      ],
    },
  ]);
  expect(popover()).toBeNull();
  expect(kept(app), "what went out is gone, the older one stays").toEqual([
    "Of an older head",
  ]);
  expect(finish().textContent).toBe("Finish review");
});

it("takes a comment only on your own pull request, and Request changes only with a summary", async () => {
  const own = await openFiles({
    fields: { viewerIsAuthor: true, author: "octo" },
    drafts: [draft(11, "Note to self")],
  });
  const mine = await openPopover(own);
  expect(
    [...mine.querySelectorAll("input[type=radio]")].map(
      (radio) => radio.parentElement?.textContent,
    ),
  ).toEqual(["CommentGive feedback without approving."]);
  expect(mine.textContent).toContain(
    "This is your pull request, so GitHub takes a comment only.",
  );

  const app = await openFiles({ drafts: [draft(11, "Hm")] });
  const shown = await openPopover(app);
  expect((get("radio", /^Comment/, shown) as HTMLInputElement).checked).toBe(
    true,
  );
  await app.click(get("radio", /^Request changes/, shown));
  expect(submit().getAttribute("aria-disabled")).toBe("true");
  expect(shown.textContent).toContain(
    "Request changes needs a summary, as GitHub requires.",
  );
  await app.click(submit());
  expect(mutations(app)).toEqual([]);
  await app.type(get("textbox", "Summary", shown), "Please split it.");
  await app.click(submit());
  expect(mutations(app)).toMatchObject([
    { kind: "submitReview", event: "requestChanges", body: "Please split it." },
  ]);
});

it("says when you have a review in progress on GitHub, and submits that one as it is", async () => {
  const app = await openFiles({
    fields: {
      pending: {
        kind: "review",
        id: "PRR_9",
        comments: page([{ path: "src/a.ts" }, { path: "src/b.ts" }]),
      },
    } as Partial<PullRequest>,
    drafts: [draft(11, "Local words")],
  });
  const shown = await openPopover(app);
  expect(shown.textContent).toContain(
    "You have a review in progress on GitHub with 2 comments. GitHub takes one review at a time, so L1 Git can't add to it.",
  );
  expect(shown.textContent).toContain(
    "Your 1 pending comment here stays on this computer.",
  );
  expect(get("link", "Open it on GitHub", shown).getAttribute("href")).toBe(
    "https://github.com/octo/pin/pull/1/files",
  );
  await app.click(get("button", "Submit it as it is", shown));
  expect(mutations(app)).toEqual([
    { kind: "submitPending", review: "PRR_9", event: "comment", body: "" },
  ]);
  expect(kept(app)).toEqual(["Local words"]);
});

it("reminds of files not viewed and threads not resolved, and still sends", async () => {
  const app = await openFiles({
    fields: { threads: page([thread("T1", "sara")]) },
    drafts: [draft(11, "One")],
  });
  const shown = await openPopover(app);
  expect(get("region", "Before you send", shown).textContent).toBe(
    "2 of 2 files not viewed yetShow themsara's thread on a.ts:11 is unresolvedOpen",
  );
  expect(submit().getAttribute("aria-disabled")).toBe("false");
  await app.click(get("button", "Show them", shown));
  expect(popover()).toBeNull();
});

it("goes to a pending comment's file, and closes with Escape back to its button", async () => {
  const app = await openFiles({
    drafts: [draft(12, "Over there", {}, "src/b.ts")],
  });
  let shown = await openPopover(app);
  await app.press("Escape");
  expect(popover()).toBeNull();
  expect(focused()).toBe("button Finish review, 1 pending comment");
  shown = await openPopover(app);
  await app.click(get("button", /^b\.ts:12/, shown));
  expect(popover()).toBeNull();
  expect(document.querySelector(".file-diff-path")?.textContent).toBe(
    "src/b.ts",
  );
});

it("counts a new comment only once Start a review keeps it", async () => {
  const app = await openFiles({ drafts: [draft(11, "Kept one")] });
  const number = panel()
    .querySelector("diffs-container")!
    .shadowRoot!.querySelector<HTMLElement>(
      '[data-column-number="12"][data-line-type="change-addition"]',
    )!;
  await app.act(() => {
    for (const [target, kind] of [
      [number, "pointerdown"],
      [document, "pointerup"],
    ] as const)
      target.dispatchEvent(
        new PointerEvent(kind, {
          bubbles: true,
          composed: true,
          pointerType: "mouse",
          button: 0,
          pointerId: 1,
        }),
      );
  });
  await app.type(get("textbox", "Comment on line 12"), "Half a thought");
  expect(finish().textContent).toBe("Finish review · 1");
  await app.click(get("button", "Add review comment"));
  expect(finish().textContent).toBe("Finish review · 2");
});

it("fits under its button in the window, and keeps fitting as the window changes", async () => {
  const app = await openFiles({ drafts: [draft(11, "Tall")] });
  finish().getBoundingClientRect = () =>
    ({ top: 180, bottom: 208, left: 1300, right: 1392 }) as DOMRect;
  const height = window.innerHeight;
  window.innerHeight = 900;
  const shown = await openPopover(app);
  expect(shown.style.top).toBe("214px");
  expect(shown.style.maxHeight, "the window's height below its top").toBe(
    "678px",
  );
  window.innerHeight = 700;
  await app.act(() => {
    window.dispatchEvent(new Event("resize"));
  });
  expect(shown.style.maxHeight).toBe("478px");
  window.innerHeight = height;
});
