import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { hostRoute } from "./domain/host";
import { draftKey } from "./domain/drafts";
import type { Anchor } from "./domain/drafts";
import type { Oid } from "./domain/repository";
import { createDrafts } from "./drafts";
import { createHostClient } from "./host";
import { createBridge } from "./test/fakeBridge";
import type { Bridge } from "./test/fakeBridge";
import { send } from "./transport";

const HEAD = "a".repeat(40) as Oid;
const NEXT = "b".repeat(40) as Oid;
const pull = {
  login: "octo",
  repository: { owner: "octo", repo: "pin" },
  number: 7,
};
const stored = "octo octo/pin#7";
const conversation: Anchor = { kind: "conversation" };
const line: Anchor = {
  kind: "line",
  path: "src/main.rs",
  side: "right",
  line: 12,
  start: { side: "right", line: 10 },
};

let bridge: Bridge;
beforeEach(() => {
  vi.useFakeTimers();
  bridge = createBridge();
  vi.stubGlobal("fetch", bridge.fetch);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** One window of L1 Git. */
const window = () =>
  createDrafts(createHostClient((request) => send(hostRoute, request)));

const changes = () =>
  bridge.hostLog
    .filter(({ op }) => op === "drafts")
    .map(({ change }) => change as { kind: string; text?: string });
const texts = (drafts: ReturnType<typeof window>) =>
  drafts.read(pull).drafts.map(({ text }) => text);
const heldTexts = () =>
  (bridge.world.host.drafts.get(stored) ?? []).map(({ text }) => text);

it("saves a burst of typing once, a moment later, while signed out", async () => {
  expect(bridge.world.host.status.github.kind).toBe("notConnected");
  const drafts = window();
  for (const text of ["L", "Lo", "Looks good"])
    drafts.type(pull, conversation, HEAD, text);
  expect(drafts.read(pull).drafts[0]).toMatchObject({
    text: "Looks good",
    save: { kind: "saving" },
    writtenAt: null,
  });
  await vi.advanceTimersByTimeAsync(399);
  expect(changes()).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(changes()).toEqual([
    {
      kind: "put",
      anchor: conversation,
      head: HEAD,
      text: "Looks good",
      at: null,
    },
  ]);
  expect(drafts.read(pull).drafts[0]?.save).toEqual({ kind: "saved" });

  const later = window();
  expect(later.read(pull).read).toEqual({ kind: "unread" });
  await later.load(pull);
  expect(later.read(pull).read).toEqual({ kind: "ready" });
  expect(texts(later)).toEqual(["Looks good"]);
});

it("saves at once on flush, and sends nothing for words already saved", async () => {
  const drafts = window();
  drafts.type(pull, line, HEAD, "Off by one?");
  expect(await drafts.flush(pull)).toBe(true);
  expect(heldTexts()).toEqual(["Off by one?"]);
  drafts.type(pull, line, HEAD, "Off by one");
  drafts.type(pull, line, HEAD, "Off by one?");
  expect(await drafts.flush()).toBe(true);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(changes()).toHaveLength(1);
});

it("keeps the words when the host can't save them, and saves them on the next flush", async () => {
  const drafts = window();
  const heal = bridge.failHost(
    { kind: "storage", message: "L1 Git could not save this draft." },
    "octo/pin#7",
  );
  drafts.type(pull, conversation, HEAD, "Ship it");
  expect(await drafts.flush(pull)).toBe(false);
  expect(drafts.read(pull).drafts[0]).toMatchObject({
    text: "Ship it",
    save: { kind: "unsaved", why: "L1 Git could not save this draft." },
  });
  heal();
  expect(await drafts.flush(pull)).toBe(true);
  expect(heldTexts()).toEqual(["Ship it"]);
});

it("never overwrites what another window saved since this one read it", async () => {
  const one = window();
  const two = window();
  one.type(pull, conversation, HEAD, "First");
  await one.flush();
  await two.load(pull);
  one.type(pull, conversation, HEAD, "First, edited");
  await one.flush();

  two.type(pull, conversation, HEAD, "Second");
  expect(await two.flush()).toBe(false);
  expect(heldTexts()).toEqual(["First, edited"]);
  const [mine] = two.read(pull).drafts;
  expect(mine).toMatchObject({
    text: "Second",
    save: { kind: "changedElsewhere", theirs: { text: "First, edited" } },
  });
  two.type(pull, conversation, HEAD, "Second, still typing");
  await vi.advanceTimersByTimeAsync(1_000);
  expect(heldTexts()).toEqual(["First, edited"]);

  two.settle(pull, draftKey(conversation, HEAD), "mine");
  expect(await two.flush()).toBe(true);
  expect(heldTexts()).toEqual(["Second, still typing"]);
  await one.load(pull);
  expect(texts(one)).toEqual(["Second, still typing"]);
});

it("takes the other window's words, or their deletion, when asked", async () => {
  const one = window();
  const two = window();
  one.type(pull, conversation, HEAD, "Theirs");
  await one.flush();
  await two.load(pull);
  await one.remove(pull, conversation, HEAD);
  expect(heldTexts()).toEqual([]);

  two.type(pull, conversation, HEAD, "Mine");
  await two.flush();
  expect(two.read(pull).drafts[0]?.save).toEqual({
    kind: "changedElsewhere",
    theirs: null,
  });
  two.settle(pull, draftKey(conversation, HEAD), "theirs");
  expect(texts(two)).toEqual([]);
  await two.flush();
  expect(heldTexts()).toEqual([]);
});

it("deletes a draft another window changed, theirs too", async () => {
  const one = window();
  const two = window();
  one.type(pull, conversation, HEAD, "First");
  await one.flush();
  await two.load(pull);
  one.type(pull, conversation, HEAD, "First, edited");
  await one.flush();
  two.type(pull, conversation, HEAD, "Second");
  expect(await two.flush()).toBe(false);
  expect(two.read(pull).drafts[0]?.save.kind).toBe("changedElsewhere");

  expect(await two.remove(pull, conversation, HEAD)).toBe(true);
  expect(two.read(pull).drafts).toEqual([]);
  expect(heldTexts()).toEqual([]);
});

it("deletes a draft another window deleted first", async () => {
  const one = window();
  const two = window();
  one.type(pull, conversation, HEAD, "First");
  await one.flush();
  await two.load(pull);
  await one.remove(pull, conversation, HEAD);
  two.type(pull, conversation, HEAD, "Second");
  await two.flush();
  expect(two.read(pull).drafts[0]?.save).toEqual({
    kind: "changedElsewhere",
    theirs: null,
  });

  expect(await two.remove(pull, conversation, HEAD)).toBe(true);
  expect(two.read(pull).drafts).toEqual([]);
});

it("keeps words typed and not saved yet when it reads the host again", async () => {
  const one = window();
  const two = window();
  one.type(pull, line, HEAD, "Saved by one");
  one.type(pull, conversation, HEAD, "One's comment");
  await one.flush();
  await two.load(pull);
  two.type(pull, conversation, HEAD, "Two's edit");
  two.type(pull, { kind: "summary" }, HEAD, "Typing");
  one.type(pull, line, HEAD, "Edited by one");
  await one.flush();
  await two.load(pull);
  expect(
    two.read(pull).drafts.map(({ text, save }) => [text, save.kind]),
  ).toEqual([
    ["Edited by one", "saved"],
    ["Two's edit", "saving"],
    ["Typing", "saving"],
  ]);
  await vi.advanceTimersByTimeAsync(400);
  expect(heldTexts()).toEqual(["Edited by one", "Two's edit", "Typing"]);
});

it("deletes a draft at once, and one cleared to blank a moment later", async () => {
  const drafts = window();
  drafts.type(pull, line, HEAD, "Remove me");
  drafts.type(pull, conversation, HEAD, "Clear me");
  await drafts.flush();
  expect(await drafts.remove(pull, line, HEAD)).toBe(true);
  expect(heldTexts()).toEqual(["Clear me"]);
  drafts.type(pull, conversation, HEAD, "  ");
  await vi.advanceTimersByTimeAsync(400);
  expect(heldTexts()).toEqual([]);
  expect(drafts.read(pull).drafts).toEqual([]);

  drafts.type(pull, conversation, HEAD, "Never saved");
  drafts.type(pull, conversation, HEAD, "");
  await drafts.flush();
  expect(changes().map(({ kind }) => kind)).toEqual([
    "put",
    "put",
    "delete",
    "delete",
  ]);
});

it("keeps a line draft per head, and moves any other draft to the new head", async () => {
  const drafts = window();
  drafts.type(pull, line, HEAD, "At the old head");
  drafts.type(pull, line, NEXT, "At the new head");
  drafts.type(pull, conversation, HEAD, "Looks good");
  await drafts.flush();
  drafts.type(pull, conversation, NEXT, "Looks good now");
  await drafts.flush();
  expect(
    bridge.world.host.drafts.get(stored)?.map(({ head, text }) => [head, text]),
  ).toEqual([
    [HEAD, "At the old head"],
    [NEXT, "At the new head"],
    [NEXT, "Looks good now"],
  ]);
});

it("saves again when the head moves while a save is on its way", async () => {
  const drafts = window();
  const held = bridge.hold("drafts");
  drafts.type(pull, conversation, HEAD, "Looks good");
  const first = drafts.flush();
  await held.arrived;
  drafts.type(pull, conversation, NEXT, "Looks good");
  held.release();
  await first;
  await vi.advanceTimersByTimeAsync(400);
  expect(bridge.world.host.drafts.get(stored)?.map(({ head }) => head)).toEqual(
    [NEXT],
  );
  expect(drafts.read(pull).drafts[0]?.save).toEqual({ kind: "saved" });
});

it("keeps accounts and pull requests apart", async () => {
  const drafts = window();
  drafts.type(pull, conversation, HEAD, "Octo's");
  drafts.type({ ...pull, login: "hubot" }, conversation, HEAD, "Hubot's");
  drafts.type({ ...pull, number: 8 }, conversation, HEAD, "On #8");
  await drafts.flush();
  expect(texts(drafts)).toEqual(["Octo's"]);
  const again = window();
  await again.load({ ...pull, login: "OCTO" });
  expect(
    again.read({ ...pull, login: "Octo" }).drafts.map(({ text }) => text),
  ).toEqual(["Octo's"]);
  expect(bridge.world.host.drafts.get("hubot octo/pin#7")?.[0]?.text).toBe(
    "Hubot's",
  );
});

it("answers the same view until something about that pull request changes", async () => {
  const drafts = window();
  const other = { ...pull, number: 8 };
  drafts.type(other, conversation, HEAD, "Elsewhere");
  const before = drafts.read(other);
  const listener = vi.fn();
  drafts.subscribe(listener);
  drafts.type(pull, conversation, HEAD, "Here");
  const view = drafts.read(pull);
  expect(drafts.read(pull)).toBe(view);
  expect(drafts.read(other)).toBe(before);
  expect(listener).toHaveBeenCalledOnce();
  await drafts.flush(pull);
  expect(drafts.read(pull)).not.toBe(view);
  expect(drafts.read(other)).toBe(before);
});

it("says when a pull request has no room for one more draft", async () => {
  const drafts = window();
  const at = (number: number): Anchor => ({
    ...line,
    line: number,
    start: null,
  });
  for (let number = 1; number <= 100; number += 1)
    drafts.type(pull, at(number), HEAD, "x");
  expect(await drafts.flush()).toBe(true);
  drafts.type(pull, conversation, HEAD, "One more");
  expect(await drafts.flush()).toBe(false);
  expect(drafts.read(pull).drafts.at(-1)).toMatchObject({
    text: "One more",
    save: {
      kind: "unsaved",
      why: "This pull request already has 100 drafts on this computer. Send or delete one to save this.",
    },
  });
});

it("says when drafts for one more pull request have no room, and drops none", async () => {
  const draft = {
    anchor: conversation,
    head: HEAD,
    text: "Kept",
    writtenAt: 1,
    savedAt: 1,
    mayHavePosted: false,
  };
  for (let number = 1; number <= 100; number += 1)
    bridge.world.host.drafts.set(`octo octo/pin#${number + 100}`, [draft]);
  const drafts = window();
  drafts.type(pull, conversation, HEAD, "New");
  expect(await drafts.flush()).toBe(false);
  expect(drafts.read(pull).drafts).toMatchObject([
    {
      text: "New",
      save: {
        kind: "unsaved",
        why: "L1 Git keeps drafts for 100 pull requests on this computer. Send or delete the drafts of another pull request to save this.",
      },
    },
  ]);
  expect(bridge.world.host.drafts.size).toBe(100);
  bridge.world.host.drafts.delete("octo octo/pin#101");
  expect(await drafts.flush()).toBe(true);
  expect(heldTexts()).toEqual(["New"]);
});

/** The host checks the same cases in `crates/host/tests/drafts.rs`. */
const textCases = z
  .array(
    z.object({
      text: z.string(),
      times: z.number(),
      host: z.enum(["takes", "blank", "tooLong"]),
    }),
  )
  .parse(
    JSON.parse(
      readFileSync(
        new URL("../crates/host/tests/draft-texts.json", import.meta.url),
        "utf8",
      ),
    ),
  );

const codePoints = (text: string) =>
  [...text]
    .map((char) => `U+${char.codePointAt(0)?.toString(16).padStart(4, "0")}`)
    .join(" ");

it.each(
  textCases.map(
    (item) => [`${item.times} × ${codePoints(item.text)}`, item] as const,
  ),
)("sends %s only when the host takes it", async (_, { text, times, host }) => {
  const drafts = window();
  drafts.type(pull, conversation, HEAD, text.repeat(times));
  expect(await drafts.flush()).toBe(host !== "tooLong");
  expect(changes().map(({ kind }) => kind)).toEqual(
    host === "takes" ? ["put"] : [],
  );
  expect(drafts.read(pull).drafts.map(({ save }) => save)).toEqual(
    host === "takes"
      ? [{ kind: "saved" }]
      : host === "tooLong"
        ? [{ kind: "tooLong", most: 65_536 }]
        : [],
  );
});

it("tries a draft that was too long again once it fits", async () => {
  const drafts = window();
  drafts.type(pull, conversation, HEAD, "x".repeat(65_537));
  expect(await drafts.flush()).toBe(false);
  drafts.type(pull, conversation, HEAD, "x".repeat(65_536));
  expect(drafts.read(pull).drafts[0]?.save).toEqual({ kind: "saving" });
  expect(await drafts.flush()).toBe(true);
  expect(heldTexts()).toEqual(["x".repeat(65_536)]);
});

it("sends a range of one line with no start, and a range dragged upward in order", async () => {
  const drafts = window();
  const at = (line: number, start: number): Anchor => ({
    kind: "line",
    path: "a.rs",
    side: "right",
    line,
    start: { side: "right", line: start },
  });
  drafts.type(pull, at(5, 5), HEAD, "One line");
  drafts.type(pull, at(3, 9), HEAD, "Upward");
  expect(await drafts.flush()).toBe(true);
  expect(
    bridge.world.host.drafts.get(stored)?.map(({ anchor }) => anchor),
  ).toEqual([{ ...at(5, 5), start: null }, { ...at(9, 3) }]);
  expect(drafts.read(pull).drafts.map(({ key }) => key)).toEqual([
    draftKey(at(5, 5), HEAD),
    draftKey(at(3, 9), HEAD),
  ]);
  drafts.type(pull, at(9, 3), HEAD, "Upward, edited");
  expect(texts(drafts)).toEqual(["One line", "Upward, edited"]);
});

it("keeps words typed where a write that may have posted holds the place, and saves them once it is kept", async () => {
  const drafts = window();
  drafts.type(pull, conversation, HEAD, "Thanks!");
  await drafts.flush(pull);
  const [saved] = bridge.world.host.drafts.get(stored) ?? [];
  if (!saved) throw new Error("the draft was saved");
  expect(drafts.carried(pull, conversation, HEAD)).toEqual({
    anchor: conversation,
    head: HEAD,
    at: saved.savedAt,
  });
  bridge.world.host.drafts.set(stored, []);
  bridge.world.host.sent.set(stored, [
    {
      attempt: "a-1",
      at: 1,
      write: { kind: "comment", pull: "PR_7" as never, body: "Thanks!" },
      drafts: [saved],
      sending: false,
      applied: false,
    },
  ]);
  expect(
    drafts.type(pull, conversation, HEAD, "Thanks! And"),
    "this window doesn't know yet",
  ).toBe("typed");
  expect(drafts.carried(pull, conversation, HEAD), "not saved yet").toBe(null);
  expect(await drafts.flush(pull)).toBe(false);
  expect(drafts.read(pull)).toMatchObject({
    drafts: [
      {
        text: "Thanks! And",
        save: { kind: "unsaved", why: /saves these once it ends/ },
      },
    ],
    sent: [{ attempt: "a-1", sending: false }],
  });
  expect(drafts.held(pull, conversation, HEAD)).toBe(true);
  expect(drafts.type(pull, conversation, HEAD, "Thanks! And more")).toBe(
    "held",
  );
  expect(texts(drafts)).toEqual(["Thanks! And"]);

  expect(await drafts.keep(pull, "a-1")).toBe(true);
  expect(drafts.held(pull, conversation, HEAD)).toBe(false);
  expect(await drafts.flush(pull)).toBe(true);
  expect(drafts.read(pull)).toMatchObject({
    drafts: [{ text: "Thanks! And", mayHavePosted: true }],
    sent: [],
  });
  expect(heldTexts()).toEqual(["Thanks! And"]);
});

it("answers held to typing where a write holds the place, and changes nothing until it ends", async () => {
  const drafts = window();
  drafts.type(pull, conversation, HEAD, "Thanks!");
  drafts.type(pull, line, HEAD, "Off by one?");
  await drafts.flush(pull);
  const [saved, other] = bridge.world.host.drafts.get(stored) ?? [];
  if (!saved || !other) throw new Error("the drafts were saved");
  bridge.world.host.drafts.set(stored, [other]);
  bridge.world.host.sent.set(stored, [
    {
      attempt: "a-1",
      at: 1,
      write: { kind: "comment", pull: "PR_7" as never, body: "Thanks!" },
      drafts: [saved],
      sending: true,
      applied: false,
    },
  ]);
  await drafts.load(pull);
  const before = changes().length;
  expect(drafts.held(pull, conversation, HEAD)).toBe(true);
  expect(drafts.held(pull, line, HEAD), "another place").toBe(false);
  expect(drafts.type(pull, conversation, HEAD, "Thanks! And")).toBe("held");
  expect(await drafts.remove(pull, conversation, HEAD)).toBe(false);
  expect(drafts.type(pull, line, HEAD, "Off by two?")).toBe("typed");
  expect(await drafts.flush(pull)).toBe(true);
  expect(changes().slice(before)).toMatchObject([{ text: "Off by two?" }]);
  expect(bridge.world.host.sent.get(stored)?.[0]?.drafts).toEqual([saved]);

  bridge.world.host.sent.set(stored, []);
  await drafts.load(pull);
  expect(drafts.held(pull, conversation, HEAD)).toBe(false);
  expect(drafts.type(pull, conversation, HEAD, "Hello")).toBe("typed");
});

it("holds the places a write this window sends carries until it lets go", () => {
  const drafts = window();
  const views: unknown[] = [];
  drafts.subscribe(() => views.push(drafts.read(pull)));
  const release = drafts.hold(pull, [{ anchor: conversation, head: HEAD }]);
  expect(drafts.held(pull, conversation, HEAD)).toBe(true);
  expect(drafts.type(pull, conversation, HEAD, "Thanks!")).toBe("held");
  expect(drafts.read(pull).drafts).toEqual([]);
  release();
  expect(views.length, "both told").toBe(2);
  expect(drafts.held(pull, conversation, HEAD)).toBe(false);
  expect(drafts.type(pull, conversation, HEAD, "Thanks!")).toBe("typed");
});
