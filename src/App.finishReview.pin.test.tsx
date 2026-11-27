// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import type { Draft } from "./domain/drafts";
import type { PullRequest, ReviewThread } from "./domain/pullRequest";
import { oidSchema } from "./domain/repository";
import {
  focused,
  get,
  installHarness,
  query,
  queryAll,
} from "./test/appHarness";
import type { Harness } from "./test/appHarness";
import { pullKey } from "./test/fakeBridge";
import type { Bridge, World } from "./test/fakeBridge";
import { at, open, page, pull, tab, visit } from "./test/pullRequests";

installHarness();

const oid = (digit: string) => oidSchema.parse(digit.repeat(40));
const head = oid("1");
const book = "octo octo/pin#1";
const patchOf = (path: string) => `diff --git a/${path} b/${path}
--- a/${path}
+++ b/${path}
@@ -10,3 +10,4 @@
 one
-two
+TWO
+and
 three
`;
const paths = ["src/a.ts", "src/b.ts"];

function answer(bridge: Bridge) {
  bridge.respond("rangeFiles", () => ({
    kind: "ready",
    mergeBase: oid("a"),
    files: paths.map((path) => ({
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
    })),
    contentMissing: false,
    shallow: false,
  }));
  bridge.respond("rangePatches", () =>
    paths.map((path) => ({
      path,
      patch: { kind: "text", patch: patchOf(path), lossy: false },
    })),
  );
}

const draft = (
  line: number,
  text: string,
  fields: Partial<Draft> = {},
  path = "src/a.ts",
): Draft => ({
  anchor: { kind: "line", path, side: "right", line, start: null },
  head,
  text,
  writtenAt: 1,
  savedAt: 1,
  mayHavePosted: false,
  ...fields,
});
const thread = (id: string, by: string): ReviewThread => ({
  id,
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
  comments: page([{ id: `${id}-1`, by, at: at(2), body: "Why?" }]),
});

async function openFiles({
  fields = {},
  drafts = [],
  world,
}: {
  fields?: Partial<PullRequest>;
  drafts?: Draft[];
  world?: (world: World) => void;
} = {}): Promise<Harness> {
  const app = await visit({
    bridge: answer,
    world: (each) => {
      each.host.details.set(pullKey("octo/pin", 1), pull(1, fields));
      each.host.drafts.set(book, drafts);
      world?.(each);
    },
  });
  await open(app, 1);
  await app.click(tab("Files changed"));
  return app;
}

const finish = () => get("button", /^Finish review/);
const panel = () => get("tabpanel", /^Files changed/);
const popover = () => query("dialog", "Finish your review");
const mutations = (app: Harness) => app.bridge.world.host.mutations;
const kept = (app: Harness) =>
  (app.bridge.world.host.drafts.get(book) ?? []).map(({ text }) => text);
const submit = () => get("button", /^Submit/, popover()!);
async function openPopover(app: Harness) {
  await app.click(finish());
  return popover()!;
}

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

it("sends nothing while a review is on its way, and shows it as sending", async () => {
  const app = await openFiles({ drafts: [draft(11, "Once")] });
  const shown = await openPopover(app);
  const held = app.bridge.hold("write");
  await app.click(submit());
  expect(shown.getAttribute("aria-busy")).toBe("true");
  expect(get("status", "Sending your review…", shown)).toBeTruthy();
  for (let frame = 0; frame < 5; frame += 1) await app.flushFrames();
  expect(
    queryAll("region", "Pending comment"),
    "its comments show once, as on their way",
  ).toEqual([]);
  expect(get("region", "Review comment").textContent).toContain("Sending…");
  expect(
    get("region", "1 pending comment", shown).textContent,
    "the popover still lists what it sends",
  ).toBe("1 pending commenta.ts:11Once");
  await app.click(submit());
  await app.press("Enter", { ctrlKey: true });
  held.release();
  await app.settle();
  expect(mutations(app)).toHaveLength(1);
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

it("keeps the pending comments when GitHub refuses, and says why", async () => {
  const app = await openFiles({
    drafts: [draft(11, "Kept")],
    world: (world) => {
      world.host.writes = [
        {
          kind: "refused",
          message: "GitHub didn't do it: Pull request is locked.",
        },
      ];
    },
  });
  const shown = await openPopover(app);
  await app.click(submit());
  expect(shown.querySelector("[role=alert]")?.textContent).toBe(
    "GitHub didn't do it: Pull request is locked.",
  );
  expect(kept(app)).toEqual(["Kept"]);
  expect(finish().textContent).toBe("Finish review · 1");
});

it("offers three choices when the review may have posted, and sends it again only when asked", async () => {
  const app = await openFiles({
    drafts: [draft(11, "Lost answer")],
    world: (world) => {
      world.host.writes = [{ kind: "unknown", applied: false }];
    },
  });
  const shown = await openPopover(app);
  await app.click(submit());
  expect(shown.textContent).toContain("may have posted");
  expect(get("link", "Open on GitHub", shown)).toBeTruthy();
  expect(shown.textContent).toContain(
    "Send anyway may post your review twice, with every comment in it.",
  );
  const summary = () => get("textbox", "Summary", shown) as HTMLTextAreaElement;
  expect(summary().readOnly, "the host holds the words").toBe(true);
  await app.click(get("button", "Keep as draft", shown));
  expect(summary().readOnly).toBe(false);
  expect(mutations(app)).toHaveLength(1);
  expect(
    app.bridge.world.host.drafts
      .get(book)
      ?.map(({ mayHavePosted }) => mayHavePosted),
  ).toEqual([true]);
  expect(shown.textContent).toContain("May have posted");
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

it("offers the choices of a review that may have posted from before a restart", async () => {
  const lost = draft(11, "Sent before the restart");
  const summary = { ...draft(0, "Looks good"), anchor: { kind: "summary" } };
  const app = await openFiles({
    world: (world) =>
      world.host.sent.set(book, [
        {
          attempt: "before",
          at: 1,
          write: {
            kind: "submitReview",
            pull: "PR_1" as never,
            commit: head,
            event: "comment",
            body: "Looks good",
            threads: [
              {
                lines: {
                  path: "src/a.ts",
                  side: "right",
                  line: 11,
                  start: null,
                },
                body: lost.text,
              },
            ],
          },
          drafts: [lost, summary as Draft],
          sending: false,
          applied: false,
        },
      ]),
  });
  const shown = await openPopover(app);
  expect(shown.textContent).toContain("may have posted");
  expect(shown.textContent).toContain("Sent before the restart");
  const words = get("textbox", "Summary", shown) as HTMLTextAreaElement;
  expect(words.readOnly, "the host holds the summary").toBe(true);
  expect(submit().getAttribute("aria-disabled")).toBe("true");
  await app.click(get("button", "Keep as draft", shown));
  expect(words.readOnly).toBe(false);
  expect(kept(app).sort()).toEqual(["Looks good", "Sent before the restart"]);
  expect(mutations(app)).toEqual([]);
});

it("says why it sent nothing in the words every write uses", async () => {
  const app = await openFiles({
    drafts: [draft(11, "Waits its turn")],
    world: (world) =>
      world.host.sent.set(book, [
        {
          attempt: "other",
          at: 1,
          write: {
            kind: "comment",
            pull: "PR_1" as never,
            body: "From another window",
          },
          drafts: [],
          sending: true,
          applied: false,
        },
      ]),
  });
  const shown = await openPopover(app);
  await app.click(submit());
  expect(shown.querySelector("[role=alert]")?.textContent).toBe(
    "Another write to this pull request is still sending, or may have posted, so L1 Git sent nothing. Try again once that one ends.",
  );
  expect(mutations(app)).toEqual([]);
  expect(kept(app)).toEqual(["Waits its turn"]);
});

it("stays open on Escape while its review is on its way, so how it ended stays in sight", async () => {
  const app = await openFiles({
    drafts: [draft(11, "Patience")],
    world: (world) => {
      world.host.writes = [{ kind: "unknown", applied: false }];
    },
  });
  const shown = await openPopover(app);
  const held = app.bridge.hold("write");
  await app.click(submit());
  await app.press("Escape");
  expect(popover()?.hasAttribute("open")).toBe(true);
  held.release();
  await app.settle();
  expect(popover()?.hasAttribute("open")).toBe(true);
  expect(get("button", "Send anyway", shown)).toBeTruthy();
  await app.press("Escape");
  expect(popover()).toBeNull();
  await app.click(finish());
  expect(popover()?.hasAttribute("open"), "the button opens it again").toBe(
    true,
  );
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

it("says Review sent. for 8 seconds or until Finish review opens again, and gives the focus back to Finish review", async () => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout"],
    shouldAdvanceTime: true,
  });
  try {
    const app = await openFiles({ drafts: [draft(11, "Done soon")] });
    await openPopover(app);
    await app.click(submit());
    await app.settle();
    expect(popover()).toBeNull();
    expect(get("status", "Review sent.")).toBeTruthy();
    expect(focused()).toBe("button Finish review");
    await app.act(() => {
      vi.advanceTimersByTime(7_000);
    });
    expect(
      query("status", "Review sent."),
      "still there after 7 s",
    ).toBeTruthy();
    await app.act(() => {
      vi.advanceTimersByTime(1_500);
    });
    expect(query("status", "Review sent.")).toBeNull();

    await app.click(finish());
    await app.type(get("textbox", "Summary", popover()!), "Once more");
    await app.click(submit());
    await app.settle();
    expect(get("status", "Review sent.")).toBeTruthy();
    await app.click(finish());
    expect(query("status", "Review sent."), "a new action moves on").toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

it("says a review may have posted over the end of the diff, not in the toolbar beside the file's path", async () => {
  const app = await openFiles({
    drafts: [draft(11, "Lost again")],
    world: (world) => {
      world.host.writes = [{ kind: "unknown", applied: false }];
    },
  });
  await openPopover(app);
  await app.click(submit());
  await app.press("Escape");
  expect(popover()).toBeNull();
  expect(document.querySelector(".finish-sent")?.textContent).toBe("");
  const notice = get("status", /^Your review may have posted\./);
  expect(notice.textContent).toBe(
    "Your review may have posted. Finish review says what you can do.Open Finish review",
  );
  await app.click(get("button", "Open Finish review", notice));
  expect(get("button", "Send anyway", popover()!)).toBeTruthy();
});
