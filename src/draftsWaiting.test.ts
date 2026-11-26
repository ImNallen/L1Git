import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { hostRoute } from "./domain/host";
import { draftKey } from "./domain/drafts";
import type { Anchor, Draft } from "./domain/drafts";
import type { Oid } from "./domain/repository";
import { createDrafts } from "./drafts";
import { createHostClient } from "./host";
import { createBridge } from "./test/fakeBridge";
import type { Bridge } from "./test/fakeBridge";
import { giveBack } from "./test/fakeDrafts";
import { send } from "./transport";

const HEAD = "a".repeat(40) as Oid;
const pull = {
  login: "octo",
  repository: { owner: "octo", repo: "pin" },
  number: 7,
};
const stored = "octo octo/pin#7";
const conversation: Anchor = { kind: "conversation" };
const key = draftKey(conversation, HEAD);

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

const texts = (drafts: ReturnType<typeof window>) =>
  drafts.read(pull).drafts.map(({ text }) => text);
const heldTexts = () =>
  (bridge.world.host.drafts.get(stored) ?? []).map(({ text }) => text);

/** Another window sends the conversation draft the host holds now. */
function sends(sending = true): Draft {
  const [carried] = bridge.world.host.drafts.get(stored) ?? [];
  if (!carried) throw new Error("a saved draft to send");
  bridge.world.host.drafts.set(stored, []);
  bridge.world.host.sent.set(stored, [
    {
      attempt: "a-1",
      at: 1,
      write: { kind: "comment", pull: "PR_7" as never, body: carried.text },
      drafts: [carried],
      sending,
      applied: false,
    },
  ]);
  return carried;
}

it("never saves words typed on an older draft over the newer one a refused write gives back", async () => {
  const first = window();
  const second = window();
  first.type(pull, conversation, HEAD, "A B");
  expect(await first.flush(pull)).toBe(true);
  await second.load(pull);
  expect(texts(second)).toEqual(["A B"]);
  first.type(pull, conversation, HEAD, "A B C");
  expect(await first.flush(pull)).toBe(true);
  sends();

  expect(second.type(pull, conversation, HEAD, "A B X")).toBe("typed");
  expect(await second.flush(pull)).toBe(false);
  giveBack(bridge.world.host, stored, "a-1", false);
  await second.load(pull);
  expect(await second.flush(pull)).toBe(false);
  expect(heldTexts()).toEqual(["A B C"]);
  expect(second.read(pull).drafts).toMatchObject([
    {
      text: "A B X",
      save: { kind: "changedElsewhere", theirs: { text: "A B C" } },
    },
  ]);

  second.settle(pull, key, "mine");
  expect(await second.flush(pull)).toBe(true);
  expect(heldTexts(), "kept only once picked").toEqual(["A B X"]);
});

it("saves words typed on the very draft a write carried over what it gives back", async () => {
  const first = window();
  const second = window();
  first.type(pull, conversation, HEAD, "A B C");
  expect(await first.flush(pull)).toBe(true);
  await second.load(pull);
  sends();

  expect(second.type(pull, conversation, HEAD, "A B C X")).toBe("typed");
  expect(await second.flush(pull)).toBe(false);
  giveBack(bridge.world.host, stored, "a-1", false);
  await second.load(pull);
  expect(await second.flush(pull)).toBe(true);
  expect(heldTexts()).toEqual(["A B C X"]);
});

it("keeps words that wait on a write through closing the window", async () => {
  const first = window();
  first.type(pull, conversation, HEAD, "A B C");
  expect(await first.flush(pull)).toBe(true);
  await first.load(pull);
  sends();
  expect(first.type(pull, conversation, HEAD, "A B C X")).toBe("typed");
  expect(await first.flush(pull)).toBe(false);

  const reopened = window();
  await reopened.load(pull);
  expect(reopened.held(pull, conversation, HEAD)).toBe(true);
  expect(reopened.read(pull).drafts).toMatchObject([
    { text: "A B C X", save: { kind: "unsaved", why: /once it ends/ } },
  ]);
  giveBack(bridge.world.host, stored, "a-1", false);
  await reopened.load(pull);
  expect(await reopened.flush(pull)).toBe(true);
  expect(heldTexts()).toEqual(["A B C X"]);
});

it("offers both words after a close when they were typed on an older draft, and forgets the ones not picked", async () => {
  const first = window();
  first.type(pull, conversation, HEAD, "A B");
  expect(await first.flush(pull)).toBe(true);
  const second = window();
  await second.load(pull);
  first.type(pull, conversation, HEAD, "A B C");
  expect(await first.flush(pull)).toBe(true);
  sends();
  second.type(pull, conversation, HEAD, "A B X");
  expect(await second.flush(pull)).toBe(false);
  giveBack(bridge.world.host, stored, "a-1", false);

  const reopened = window();
  await reopened.load(pull);
  expect(reopened.read(pull).drafts).toMatchObject([
    {
      text: "A B X",
      save: { kind: "changedElsewhere", theirs: { text: "A B C" } },
    },
  ]);
  reopened.settle(pull, key, "theirs");
  expect(await reopened.flush(pull)).toBe(true);
  const later = window();
  await later.load(pull);
  expect(later.read(pull).drafts).toMatchObject([
    { text: "A B C", save: { kind: "saved" } },
  ]);
});
