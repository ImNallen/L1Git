// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import type { Draft } from "./domain/drafts";
import {
  focused,
  get,
  installHarness,
  query,
  queryAll,
} from "./test/appHarness";
import {
  book,
  draft,
  finish,
  head,
  kept,
  mutations,
  openFiles,
  openPopover,
  popover,
  submit,
} from "./test/finishReview";

installHarness();

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
