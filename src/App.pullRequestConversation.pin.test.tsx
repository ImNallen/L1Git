// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { get, installHarness, query, queryAll } from "./test/appHarness";
import type { Harness } from "./test/appHarness";
import { open, visit } from "./test/pullRequests";

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
