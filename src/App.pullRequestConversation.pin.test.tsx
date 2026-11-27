// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import type { ReviewThread } from "./domain/pullRequest";
import { get, installHarness, query, queryAll } from "./test/appHarness";
import type { Harness } from "./test/appHarness";
import { pullKey } from "./test/fakeBridge";
import type { World } from "./test/fakeBridge";
import { at, open, page, pull, visit } from "./test/pullRequests";

installHarness();

const box = () => get("group", "Comment on this pull request");
const words = () => get("textbox", "Comment", box()) as HTMLTextAreaElement;
const status = () => box().querySelector(".comment-box-status")?.textContent;
const said = () => document.querySelector(".conversation")?.textContent ?? "";
const drafts = (app: Harness) =>
  app.bridge.world.host.drafts.get("octo octo/pin#1") ?? [];
const sent = (app: Harness) => app.bridge.world.host.mutations;
async function settled(app: Harness) {
  for (let frame = 0; frame < 5; frame += 1) await app.flushFrames();
}
async function comment(app: Harness, text: string) {
  await app.type(words(), text);
  await app.click(get("button", "Comment", box()));
}

const thread = (
  id: string,
  fields: Partial<ReviewThread> = {},
): ReviewThread => ({
  id,
  review: null,
  path: "a.ts",
  line: 3,
  startLine: null,
  originalLine: 3,
  originalStartLine: null,
  side: "right",
  outdated: false,
  resolved: false,
  hunk: "",
  can: { reply: true, resolve: true, unresolve: false },
  comments: page([{ id: `${id}-1`, body: "Rename it", by: "sara", at: at(3) }]),
  ...fields,
});
const withThreads =
  (...threads: ReviewThread[]) =>
  (world: World) =>
    world.host.details.set(
      pullKey("octo/pin", 1),
      pull(1, { threads: page(threads) }),
    );
const region = () => get("region", "Thread on a.ts");

it("saves a comment as a draft on this machine, and sends it once with Cmd or Ctrl+Enter", async () => {
  const app = await visit();
  await open(app, 1);
  expect(
    queryAll("button", undefined, box()).map((button) => button.textContent),
    "your own pull request gets the same box: Comment only",
  ).toEqual(["Write", "Preview", "Comment"]);
  expect(words().placeholder).toBe("Leave a comment. Markdown works here.");
  await app.type(words(), "Looks **good**");
  await vi.waitFor(() =>
    expect(drafts(app)).toMatchObject([{ text: "Looks **good**" }]),
  );
  expect(status()).toMatch(
    /Enter to comment · Saved as a draft on this machine$/,
  );
  expect(sent(app), "typing sends nothing").toEqual([]);

  await app.press("Enter", { target: words(), ctrlKey: true });
  await vi.waitFor(() =>
    expect(sent(app)).toEqual([
      { kind: "comment", pull: "PR_1", body: "Looks **good**" },
    ]),
  );
  await settled(app);
  expect(words().value).toBe("");
  expect(drafts(app)).toEqual([]);
  expect(said()).toContain("Looks good");
  expect(sent(app)).toHaveLength(1);
});

it("keeps the words as they are while they are on their way", async () => {
  const app = await visit();
  await open(app, 1);
  const answer = app.bridge.hold("write");
  await comment(app, "Thanks!");
  await answer.arrived;
  expect(words().readOnly).toBe(true);
  expect(words().value).toBe("Thanks!");
  expect(status()).toBe("Sending…");
  expect(box().getAttribute("aria-busy")).toBe("true");
  await app.press("Enter", { target: words(), metaKey: true });
  await app.click(get("button", "Comment", box()));
  answer.release();
  await vi.waitFor(() => expect(words().readOnly).toBe(false));
  expect(sent(app)).toHaveLength(1);
});

it("says when the base changed", async () => {
  const retarget = {
    id: "B1",
    kind: "baseChanged" as const,
    from: "main",
    to: "release",
    by: "maja",
    at: at(4),
  };
  const app = await visit({
    world: (world) =>
      world.host.details.set(
        pullKey("octo/pin", 1),
        pull(1, { timeline: page([retarget]) }),
      ),
  });
  await open(app, 1);
  const line = [...document.querySelectorAll(".entry-line")].find((entry) =>
    entry.textContent?.includes("base"),
  );
  expect(line?.textContent).toMatch(
    /^maja changed the base from main to release · /,
  );
});

it("shows Markdown in Preview", async () => {
  const app = await visit();
  await open(app, 1);
  await app.click(get("button", "Preview", box()));
  expect(box().textContent).toContain("Nothing to preview.");
  await app.click(get("button", "Write", box()));
  await app.type(words(), "Is **this** it?");
  await app.click(get("button", "Preview", box()));
  await settled(app);
  expect(box().querySelector("strong")?.textContent).toBe("this");
  expect(sent(app)).toEqual([]);
});

it("shows GitHub's reason where you wrote, and gives the words back", async () => {
  const app = await visit();
  await open(app, 1);
  const reason = "GitHub didn't do it: This conversation is locked.";
  app.bridge.world.host.writes.push({ kind: "refused", message: reason });
  await comment(app, "Thanks!");
  await vi.waitFor(() => expect(get("alert", undefined, box())).toBeTruthy());
  expect(get("alert", undefined, box()).textContent).toContain(reason);
  expect(words().value).toBe("Thanks!");
  expect(words().readOnly).toBe(false);
  await app.click(get("button", "Dismiss", box()));
  expect(query("alert", undefined, box())).toBeNull();
  expect(sent(app)).toHaveLength(0);
});

it("says a comment may have posted, offers three choices, and sends nothing by itself", async () => {
  const app = await visit();
  await open(app, 1);
  app.bridge.world.host.writes.push({ kind: "unknown", applied: false });
  await comment(app, "Thanks!");
  await vi.waitFor(() =>
    expect(get("button", "Keep as draft", box())).toBeTruthy(),
  );
  const notice = get("alert", undefined, box());
  expect(notice.textContent).toContain("may");
  expect(notice.textContent).toContain("Send anyway may post it twice.");
  expect(get("link", "Open on GitHub", notice).getAttribute("href")).toBe(
    "https://github.com/octo/pin/pull/1",
  );
  expect(get("button", "Send anyway", notice)).toBeTruthy();
  expect(words().readOnly, "its words wait with it").toBe(true);
  expect(words().value).toBe("Thanks!");
  await settled(app);
  expect(sent(app)).toHaveLength(1);

  await app.click(get("button", "Keep as draft", box()));
  await vi.waitFor(() => expect(words().readOnly).toBe(false));
  expect(words().value).toBe("Thanks!");
  expect(box().textContent).toContain("These words may have posted already.");
  expect(sent(app)).toHaveLength(1);
});

it("replies from Reply…, and shows the reply as sent until a read has it", async () => {
  const app = await visit({ world: withThreads(thread("T1")) });
  await open(app, 1);
  await app.click(get("button", "Reply…", region()));
  const reply = get("textbox", "Reply", region()) as HTMLTextAreaElement;
  expect(document.activeElement).toBe(reply);
  const answer = app.bridge.hold("pullRequest");
  await app.type(reply, "Renamed");
  await app.click(get("button", "Reply", region()));
  await vi.waitFor(() =>
    expect(sent(app)).toEqual([
      { kind: "reply", thread: "T1", body: "Renamed" },
    ]),
  );
  await answer.arrived;
  await settled(app);
  expect(query("textbox", "Reply", region()), "the box closes").toBeNull();
  expect(region().querySelector(".thread-sent")?.textContent).toMatch(
    /You SentRenamed$/,
  );
  answer.release();
  await vi.waitFor(() =>
    expect(region().querySelector(".thread-sent")).toBeNull(),
  );
  await settled(app);
  expect(region().textContent?.match(/Renamed/g)).toHaveLength(1);
});

it("discards a reply on its button, and Cancel closes an empty one", async () => {
  const app = await visit({ world: withThreads(thread("T1")) });
  await open(app, 1);
  await app.click(get("button", "Reply…", region()));
  await app.click(get("button", "Cancel", region()));
  expect(document.activeElement).toBe(get("button", "Reply…", region()));
  await app.click(get("button", "Reply…", region()));
  await app.type(get("textbox", "Reply", region()), "Maybe");
  await vi.waitFor(() => expect(drafts(app)).toHaveLength(1));
  await app.click(get("button", "Discard", region()));
  await vi.waitFor(() => expect(drafts(app)).toEqual([]));
  expect(query("textbox", "Reply", region())).toBeNull();
  expect(sent(app)).toEqual([]);
});

it("resolves a thread, folds it, and gives focus to its row", async () => {
  const app = await visit({ world: withThreads(thread("T1")) });
  await open(app, 1);
  const resolve = get("button", "Resolve conversation", region());
  resolve.focus();
  await app.click(resolve);
  await vi.waitFor(() =>
    expect(get("button", /^Resolved/, region())).toBeTruthy(),
  );
  expect(sent(app)).toEqual([{ kind: "resolve", thread: "T1" }]);
  expect(
    get("button", /^Resolved/, region()).getAttribute("aria-expanded"),
  ).toBe("false");
  expect(document.activeElement).toBe(get("button", /^Resolved/, region()));

  await app.click(get("button", /^Resolved/, region()));
  await app.click(get("button", "Unresolve conversation", region()));
  await vi.waitFor(() =>
    expect(query("button", /^Resolved/, region())).toBeNull(),
  );
  expect(sent(app)).toEqual([
    { kind: "resolve", thread: "T1" },
    { kind: "unresolve", thread: "T1" },
  ]);
});

it("offers only what GitHub lets you do with a thread", async () => {
  const app = await visit({
    world: withThreads(
      thread("T1", { can: { reply: false, resolve: false, unresolve: false } }),
    ),
  });
  await open(app, 1);
  expect(query("button", "Reply…", region())).toBeNull();
  expect(query("button", "Resolve conversation", region())).toBeNull();
});

it("says a reply posted when GitHub's read shows only the start of its thread", async () => {
  const long = thread("T1", {
    comments: page(
      [{ id: "T1-1", body: "Rename it", by: "sara", at: at(3) }],
      60,
    ),
  });
  const app = await visit({ world: withThreads(long) });
  await open(app, 1);
  expect(region().textContent).toContain("59 comments more.");
  await app.click(get("button", "Reply…", region()));
  await app.type(get("textbox", "Reply", region()), "Renamed");
  await app.click(get("button", "Reply", region()));
  await vi.waitFor(() =>
    expect(region().textContent).toContain(
      "Posted. GitHub shows it in the full thread.",
    ),
  );
  await settled(app);
  expect(region().querySelector(".thread-sent")).toBeNull();
  expect(region().textContent).toContain(
    "Posted. GitHub shows it in the full thread.",
  );
  expect(sent(app)).toHaveLength(1);
});

it("drops an earlier failure once the next comment posts, and sends once for two quick presses", async () => {
  const app = await visit();
  await open(app, 1);
  app.bridge.world.host.writes.push({ kind: "notSent" });
  await comment(app, "Thanks!");
  await vi.waitFor(() => expect(get("alert", undefined, box())).toBeTruthy());
  expect(sent(app)).toEqual([]);
  await app.press("Enter", { target: words(), ctrlKey: true });
  await app.press("Enter", { target: words(), ctrlKey: true });
  await vi.waitFor(() => expect(words().value).toBe(""));
  await settled(app);
  expect(sent(app)).toHaveLength(1);
  expect(query("alert", undefined, box())).toBeNull();
});

it("gives focus back to Reply… once a reply posts", async () => {
  const app = await visit({ world: withThreads(thread("T1")) });
  await open(app, 1);
  await app.click(get("button", "Reply…", region()));
  const reply = get("textbox", "Reply", region());
  await app.type(reply, "Renamed");
  await app.press("Enter", { target: reply, metaKey: true });
  await vi.waitFor(() =>
    expect(query("textbox", "Reply", region())).toBeNull(),
  );
  expect(document.activeElement).toBe(get("button", "Reply…", region()));
});

it("says a reply posted to a thread whose read already holds 50 comments", async () => {
  const fifty = Array.from({ length: 50 }, (_, index) => ({
    id: `T1-${index}`,
    body: `Round ${index}`,
    by: "sara",
    at: at(3),
  }));
  const app = await visit({
    world: withThreads(thread("T1", { comments: page(fifty) })),
  });
  await open(app, 1);
  await app.click(get("button", "Reply…", region()));
  await app.type(get("textbox", "Reply", region()), "Renamed");
  await app.click(get("button", "Reply", region()));
  await vi.waitFor(() =>
    expect(region().textContent).toContain(
      "Posted. GitHub shows it in the full thread.",
    ),
  );
  expect(region().querySelector(".thread-sent")).toBeNull();
});

it("resolves once, even when clicked again before the read shows it", async () => {
  const app = await visit({ world: withThreads(thread("T1")) });
  await open(app, 1);
  const reread = app.bridge.hold("pullRequest");
  await app.click(get("button", "Resolve conversation", region()));
  await reread.arrived;
  await settled(app);
  const resolve = get("button", "Resolve conversation", region());
  expect(resolve.getAttribute("aria-disabled")).toBe("true");
  await app.click(resolve);
  reread.release();
  await vi.waitFor(() =>
    expect(get("button", /^Resolved/, region())).toBeTruthy(),
  );
  expect(sent(app)).toEqual([{ kind: "resolve", thread: "T1" }]);
});

it("says why a comment sent nothing in the words every write uses", async () => {
  const app = await visit({
    world: (world) =>
      world.host.sent.set("octo octo/pin#1", [
        {
          attempt: "elsewhere",
          at: 1,
          write: {
            kind: "resolve",
            thread: "T9",
          },
          drafts: [],
          sending: true,
          applied: false,
        },
      ]),
  });
  await open(app, 1);
  await comment(app, "Not now");
  expect(get("alert", undefined, box()).textContent).toContain(
    "Another write to this pull request is still sending, or may have posted, so L1 Git sent nothing. Try again once that one ends.",
  );
  expect(sent(app)).toEqual([]);
});

it("says Posted. for 8 seconds after the read that shows it, or until you type again", async () => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout"],
    shouldAdvanceTime: true,
  });
  try {
    const app = await visit({ world: withThreads(thread("T1")) });
    await open(app, 1);
    await comment(app, "Thanks!");
    await vi.waitFor(() => expect(sent(app)).toHaveLength(1));
    await settled(app);
    expect(said()).toContain("Thanks!");
    expect(status()).toBe("Posted.");
    expect(get("status", "Posted.", box())).toBeTruthy();
    await app.act(() => {
      vi.advanceTimersByTime(7_000);
    });
    expect(status(), "still there after 7 s").toBe("Posted.");
    await app.act(() => {
      vi.advanceTimersByTime(1_500);
    });
    expect(status()).not.toBe("Posted.");

    await comment(app, "Again");
    await vi.waitFor(() => expect(sent(app)).toHaveLength(2));
    await settled(app);
    expect(status()).toBe("Posted.");
    await app.type(words(), "M");
    expect(status(), "typing moves on").not.toBe("Posted.");

    await app.click(get("button", "Reply…", region()));
    await app.type(get("textbox", "Reply", region()), "Renamed");
    await app.click(get("button", "Reply", region()));
    await vi.waitFor(() => expect(sent(app)).toHaveLength(3));
    await settled(app);
    expect(region().textContent).toContain("Renamed");
    expect(get("status", "Posted your reply.", region())).toBeTruthy();
  } finally {
    vi.useRealTimers();
  }
});
