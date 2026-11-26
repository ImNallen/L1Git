import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { hostRoute } from "./domain/host";
import type { HostStatus } from "./domain/host";
import type { Anchor } from "./domain/drafts";
import type { PullWrite } from "./domain/pullRequestWrites";
import { rootSchema } from "./domain/repository";
import type { Oid } from "./domain/repository";
import { createDrafts } from "./drafts";
import { createHostClient } from "./host";
import { createReadQueue } from "./pullRequestQueue";
import { createPullRequests } from "./pullRequests";
import { createPullRequestWrites } from "./pullRequestWrites";
import type { PullOf } from "./pullRequestWrites";
import { createBridge, pullKey } from "./test/fakeBridge";
import type { Bridge } from "./test/fakeBridge";
import { applyLater } from "./test/fakeWrites";
import { page, pull } from "./test/pullRequests";
import { send } from "./transport";

const HEAD = "1".repeat(40) as Oid;
const repository = { owner: "octo", repo: "pin" };
const one: PullOf = { repository, number: 1 };
const two: PullOf = { repository, number: 2 };
const of = { login: "octo", ...one };
const conversation: Anchor = { kind: "conversation" };
const said = (body: string, number = 1): PullWrite => ({
  kind: "comment",
  pull: pull(number).id,
  body,
});
const merge: PullWrite = {
  kind: "merge",
  pull: pull(1).id,
  expectedHead: HEAD,
  method: "squash",
  headline: null,
  body: null,
};

const connected = (connectedAt: number): HostStatus["github"] => ({
  kind: "connected",
  login: "octo",
  api: "https://api.github.com/",
  method: "gh",
  access: "private",
  connectedAt,
});

let bridge: Bridge;
beforeEach(() => {
  bridge = createBridge();
  vi.stubGlobal("fetch", bridge.fetch);
  const { host } = bridge.world;
  host.details.set(pullKey("octo/pin", 1), pull(1));
  host.details.set(pullKey("octo/pin", 2), pull(2));
  host.status = { ...host.status, github: connected(1) };
});
afterEach(() => vi.unstubAllGlobals());

/** One window, wired as the shell wires it. */
async function window(task: () => (() => void) | null = () => () => {}) {
  const host = createHostClient((request) => send(hostRoute, request));
  await host.refresh();
  const { details } = createPullRequests(host);
  const listed = {
    key: "pin",
    name: "pin",
    root: rootSchema.parse("/work/pin"),
    github: repository,
  };
  const queue = createReadQueue(async (request) => {
    if ("number" in request)
      await details.refresh({ repository, number: request.number });
    return true;
  });
  const drafts = createDrafts(host);
  const writes = createPullRequestWrites({
    host,
    details,
    reread: ({ number }) =>
      queue.addFirst({ repository: listed, number }, { again: true }),
    drafts,
    task,
  });
  const read = (number: number) =>
    queue.addFirst({ repository: listed, number });
  // A screen builds each write from the pull request's read, and shows its
  // writes while it is open.
  await details.refresh(one);
  await details.refresh(two);
  writes.subscribe(() => {});
  return { host, details, drafts, writes, read };
}
type Window = Awaited<ReturnType<typeof window>>;

/** Types `body` as the conversation draft, saves it, and sends it. */
async function comment({ drafts, writes }: Window, body: string) {
  drafts.type(of, conversation, HEAD, body);
  await drafts.flush(of);
  return writes.send(one, said(body), [{ anchor: conversation, head: HEAD }]);
}

const mutations = () => bridge.world.host.mutations.length;
const asked = (op: string) =>
  bridge.hostLog.filter((request) => request.op === op).length;
const stored = () => bridge.world.host.drafts.get("octo octo/pin#1") ?? [];
const kept = () => bridge.world.host.sent.get("octo octo/pin#1") ?? [];
const state = ({ writes }: Window, at: PullOf = one) =>
  writes.attempts(at).at(-1)?.state;

it("sends one write per pull request at a time and answers busy to the next", async () => {
  const shown = await window();
  const { writes } = shown;
  const answer = bridge.hold("write");
  expect(writes.send(one, said("First"))).toBe("started");
  expect(writes.send(one, said("Second"))).toBe("busy");
  expect(writes.send(two, said("Elsewhere", 2)), "its own lane").toBe(
    "started",
  );
  await answer.arrived;
  expect(writes.busy(one)).toBe(true);
  answer.release();
  await vi.waitFor(() => expect(writes.busy(one)).toBe(false));
  expect(mutations()).toBe(2);
  expect(writes.send(one, said("Second"))).toBe("started");
});

it("keeps a done write's words until a read asked after its answer, and the host drops its draft at once", async () => {
  const shown = await window();
  const reread = bridge.hold("pullRequest");
  expect(await comment(shown, "Thanks!")).toBe("started");
  await reread.arrived;
  expect(state(shown)).toMatchObject({ kind: "done" });
  expect(shown.writes.busy(one), "a done write holds nothing back").toBe(false);
  expect(stored()).toEqual([]);
  expect(shown.drafts.read(of).drafts).toEqual([]);
  reread.release();
  await vi.waitFor(() => expect(shown.writes.attempts(one)).toEqual([]));
  const timeline = shown.details.read()(one).value?.timeline.items ?? [];
  expect(timeline.at(-1)).toMatchObject({ kind: "comment", body: "Thanks!" });
});

it("says a write may have posted until GitHub shows it, and never sends it again on its own", async () => {
  const shown = await window();
  bridge.world.host.writes.push({ kind: "unknown", applied: "later" });
  await comment(shown, "Thanks!");
  await vi.waitFor(() => expect(asked("check")).toBe(1));
  expect(state(shown)).toMatchObject({ kind: "unknown", kept: true });
  expect(shown.writes.busy(one)).toBe(true);
  expect(await comment(shown, "Thanks!"), "nothing else is sent").toBe("busy");
  expect(kept()[0]?.drafts).toMatchObject([{ text: "Thanks!" }]);
  await shown.read(1);
  await vi.waitFor(() => expect(asked("check")).toBe(2));
  expect(
    state(shown),
    "a read that shows nothing settles nothing",
  ).toMatchObject({ kind: "unknown" });

  applyLater(bridge.world.host);
  await shown.read(1);
  await vi.waitFor(() => expect(kept()).toEqual([]));
  await vi.waitFor(() => expect(shown.writes.attempts(one)).toEqual([]));
  expect(stored(), "its draft went with it").toEqual([]);
  expect(mutations()).toBe(1);
});

it("shows what may have posted after signing in again, in a new window or after a restart, and sends nothing for it", async () => {
  const first = await window();
  bridge.world.host.writes.push({ kind: "unknown", applied: false });
  await comment(first, "Thanks!");
  await vi.waitFor(() => expect(asked("check")).toBe(1));

  bridge.world.host.status = {
    ...bridge.world.host.status,
    revision: bridge.world.host.status.revision + 1,
    github: connected(2),
  };
  await first.host.refresh();
  await first.drafts.load(of);
  expect(state(first)).toMatchObject({ kind: "unknown", kept: true });
  expect(await comment(first, "Thanks!")).toBe("busy");

  const second = await window();
  await second.drafts.load(of);
  expect(state(second)).toMatchObject({ kind: "unknown", kept: true });
  expect(second.drafts.read(of).drafts, "not a plain draft to send").toEqual(
    [],
  );
  expect(second.writes.send(one, said("Thanks!"))).toBe("busy");
  expect(mutations()).toBe(1);
});

it("lets a second window send nothing while the first window's write is in flight", async () => {
  const first = await window();
  const second = await window();
  const answer = bridge.hold("write");
  await comment(first, "Thanks!");
  await answer.arrived;
  await second.drafts.load(of);
  expect(state(second)).toEqual({ kind: "sending" });
  expect(second.writes.send(one, said("Thanks!"))).toBe("busy");
  const late = await window();
  expect(late.writes.send(one, said("Thanks!")), "it hasn't read yet").toBe(
    "started",
  );
  await vi.waitFor(() =>
    expect(late.writes.attempts(one).map(({ state }) => state.kind)).toEqual([
      "notSent",
      "sending",
    ]),
  );
  answer.release();
  await vi.waitFor(() => expect(kept()).toEqual([]));
  expect(mutations()).toBe(1);
});

it("keeps a write that may have posted as a draft, marked, and frees the pull request", async () => {
  const shown = await window();
  bridge.world.host.writes.push({ kind: "unknown", applied: false });
  await comment(shown, "Thanks!");
  await vi.waitFor(() => expect(asked("check")).toBe(1));
  const [attempt] = shown.writes.attempts(one);
  expect(await shown.writes.keep(one, attempt?.id ?? "")).toBe(true);
  expect(shown.writes.attempts(one)).toEqual([]);
  expect(shown.writes.busy(one)).toBe(false);
  expect(shown.drafts.read(of).drafts).toMatchObject([
    { text: "Thanks!", mayHavePosted: true, save: { kind: "saved" } },
  ]);
  expect(mutations()).toBe(1);
});

it("sends anyway only when asked, and not at all once a read shows it landed", async () => {
  const shown = await window();
  bridge.world.host.writes.push({ kind: "unknown", applied: "later" });
  await comment(shown, "Thanks!");
  await vi.waitFor(() => expect(asked("check")).toBe(1));
  applyLater(bridge.world.host);
  const id = shown.writes.attempts(one)[0]?.id ?? "";
  expect(shown.writes.sendAnyway(one, id)).toBe("started");
  await vi.waitFor(() => expect(kept()).toEqual([]));
  expect(mutations(), "GitHub had it, so it wasn't sent again").toBe(1);

  bridge.world.host.writes.push({ kind: "unknown", applied: false });
  await comment(shown, "Once more");
  await vi.waitFor(() => expect(asked("check")).toBe(2));
  const again = shown.writes.attempts(one).at(-1);
  expect(again?.state).toMatchObject({ kind: "unknown", kept: true });
  expect(shown.writes.sendAnyway(one, again?.id ?? "")).toBe("started");
  await vi.waitFor(() => expect(kept()).toEqual([]));
  expect(mutations()).toBe(3);
  expect(stored()).toEqual([]);
});

it("settles a lost merge from whether it merged, so it can be sent again", async () => {
  const shown = await window();
  bridge.world.host.writes.push({ kind: "unknown", applied: false });
  shown.writes.send(one, merge);
  await vi.waitFor(() => expect(state(shown)?.kind).toBe("notLanded"));
  expect(shown.writes.busy(one)).toBe(false);
  shown.writes.send(one, merge);
  await vi.waitFor(() => expect(kept()).toEqual([]));
  expect(mutations()).toBe(2);
  expect(
    bridge.world.host.details.get(pullKey("octo/pin", 1))?.state.kind,
  ).toBe("merged");
});

it("sends nothing for a draft this window hasn't saved, and says a write that never got to Rust sent nothing", async () => {
  const shown = await window();
  shown.drafts.type(of, conversation, HEAD, "Thanks!");
  expect(
    shown.writes.send(one, said("Thanks!"), [
      { anchor: conversation, head: HEAD },
    ]),
  ).toBe("unsaved");
  await shown.drafts.flush(of);
  shown.writes.send(one, said("x".repeat(5 * 1024 * 1024)));
  await vi.waitFor(() =>
    expect(state(shown)).toMatchObject({
      kind: "notSent",
      message: /4 MiB/,
    }),
  );
  expect(bridge.hostLog.filter(({ op }) => op === "write")).toEqual([]);
  expect(shown.writes.busy(one)).toBe(false);
});

it("tells refused from not sent, rereads only after GitHub answered, and clears either notice", async () => {
  const shown = await window();
  const { writes } = shown;
  bridge.world.host.writes.push(
    {
      kind: "refused",
      message: "GitHub didn't do it: Pull request is locked.",
    },
    { kind: "notSent", message: "L1 Git sent nothing." },
  );
  const preloaded = asked("pullRequest");
  const reads = () => asked("pullRequest") - preloaded;
  writes.send(one, said("One"));
  await vi.waitFor(() => expect(state(shown)?.kind).toBe("refused"));
  expect(state(shown)).toMatchObject({ message: /locked/ });
  await vi.waitFor(() => expect(reads()).toBe(1));
  writes.send(one, said("Two"));
  await vi.waitFor(() => expect(state(shown)?.kind).toBe("notSent"));
  expect(reads()).toBe(1);
  for (const { id } of writes.attempts(one)) writes.dismiss(one, id);
  expect(writes.attempts(one)).toEqual([]);
});

it("sends nothing while signed out or while an update waits to restart, and keeps another sign-in's answer out", async () => {
  const restarting = await window(() => null);
  expect(restarting.writes.send(one, said("Hi"))).toBe("restarting");
  const { writes, host } = await window();
  const answer = bridge.hold("write");
  writes.send(one, said("Hi"));
  await answer.arrived;
  const heard = vi.fn();
  writes.subscribe(heard);
  await host.disconnect();
  expect(heard, "a sign-in change is a change").toHaveBeenCalled();
  expect(writes.send(one, said("Hi"))).toBe("signedOut");
  expect(writes.attempts(one)).toEqual([]);
  answer.release();
  await vi.waitFor(() => expect(kept()).toEqual([]));
  expect(writes.attempts(one), "an old sign-in's answer stays out").toEqual([]);
  expect(mutations()).toBe(1);
});

it("looks for a kept write as soon as a window learns of it, after its read", async () => {
  bridge.world.host.writes.push({ kind: "unknown", applied: "later" });
  const first = await window();
  await comment(first, "Thanks!");
  await vi.waitFor(() => expect(asked("check")).toBe(1));
  applyLater(bridge.world.host);
  const restarted = await window();
  const preloaded = asked("pullRequest");
  expect(restarted.writes.attempts(one)).toEqual([]);
  await restarted.read(1);
  await vi.waitFor(() => expect(asked("pullRequest")).toBe(preloaded + 1));
  await restarted.drafts.load(of);
  await vi.waitFor(() => expect(kept()).toEqual([]));
  expect(asked("check")).toBe(2);
  expect(mutations()).toBe(1);
});

it("keeps words another window typed before it learned a write carries its draft, and saves them once the write is done", async () => {
  const first = await window();
  const second = await window();
  first.drafts.type(of, conversation, HEAD, "Thanks!");
  await first.drafts.flush(of);
  await second.drafts.load(of);
  const answer = bridge.hold("write");
  first.writes.send(one, said("Thanks!"), [
    { anchor: conversation, head: HEAD },
  ]);
  await answer.arrived;
  second.drafts.type(of, conversation, HEAD, "Thanks! And one more");
  expect(await second.drafts.flush(of), "not saved while it sends").toBe(false);
  expect(second.drafts.held(of, conversation, HEAD)).toBe(true);
  expect(second.drafts.type(of, conversation, HEAD, "Thanks! And")).toBe(
    "held",
  );
  expect(kept()[0]?.drafts, "the words it sends stay as sent").toMatchObject([
    { text: "Thanks!" },
  ]);
  answer.release();
  await vi.waitFor(() => expect(kept()).toEqual([]));
  await second.drafts.load(of);
  await vi.waitFor(() =>
    expect(stored()).toMatchObject([
      { text: "Thanks! And one more", mayHavePosted: false },
    ]),
  );
  expect(second.drafts.read(of).drafts).toMatchObject([
    { text: "Thanks! And one more", save: { kind: "saved" } },
  ]);
  expect(mutations()).toBe(1);
});

it("holds the box a write carries while it sends, and frees it as the write ends", async () => {
  const shown = await window();
  const place = [conversation, HEAD] as const;
  const answer = bridge.hold("write");
  expect(await comment(shown, "Thanks!")).toBe("started");
  expect(shown.drafts.held(of, ...place)).toBe(true);
  expect(shown.drafts.type(of, ...place, "Thanks! And")).toBe("held");
  await answer.arrived;
  expect(shown.drafts.type(of, ...place, "Thanks! And")).toBe("held");
  expect(kept()[0]?.drafts).toMatchObject([{ text: "Thanks!" }]);
  answer.release();
  await vi.waitFor(() => expect(kept()).toEqual([]));
  await vi.waitFor(() => expect(shown.drafts.held(of, ...place)).toBe(false));
  expect(stored(), "done: the draft is gone").toEqual([]);
  expect(shown.drafts.read(of).drafts).toEqual([]);

  bridge.world.host.writes.push({
    kind: "refused",
    message: "GitHub didn't do it: Pull request is locked.",
  });
  await comment(shown, "Once more");
  await vi.waitFor(() => expect(state(shown)?.kind).toBe("refused"));
  expect(shown.drafts.held(of, ...place)).toBe(false);
  expect(shown.drafts.read(of).drafts).toMatchObject([
    { text: "Once more", save: { kind: "saved" } },
  ]);
  expect(shown.drafts.type(of, ...place, "Once more, please")).toBe("typed");
  await shown.drafts.flush(of);

  bridge.world.host.writes.push({ kind: "unknown", applied: false });
  expect(
    shown.writes.send(one, said("Once more, please"), [
      { anchor: conversation, head: HEAD },
    ]),
  ).toBe("started");
  await vi.waitFor(() => expect(state(shown)?.kind).toBe("unknown"));
  expect(shown.drafts.held(of, ...place), "until Keep or Send anyway").toBe(
    true,
  );
  expect(shown.drafts.type(of, ...place, "Again")).toBe("held");
  const id = shown.writes.attempts(one).at(-1)?.id ?? "";
  expect(await shown.writes.keep(one, id)).toBe(true);
  expect(shown.drafts.held(of, ...place)).toBe(false);
  expect(shown.drafts.type(of, ...place, "Again")).toBe("typed");
});

it("sends only what names this pull request, its threads and its pending review, as its read shows them", async () => {
  const thread = {
    id: "PRRT_1",
    review: null,
    path: "a.rs",
    line: 3,
    startLine: null,
    originalLine: 3,
    originalStartLine: null,
    side: "right" as const,
    outdated: false,
    resolved: false,
    hunk: "@@ -1 +1 @@",
    comments: page([]),
    can: { reply: true, resolve: true, unresolve: false },
  };
  bridge.world.host.details.set(pullKey("octo/pin", 1), {
    ...pull(1),
    threads: page([thread]),
    pending: { kind: "review", id: "PRR_1" as never, comments: page([]) },
  });
  bridge.world.host.details.set(pullKey("octo/pin", 2), {
    ...pull(2),
    threads: page([{ ...thread, id: "PRRT_2" }]),
  });
  const { writes } = await window();
  const three: PullOf = { repository, number: 3 };
  const pending: PullWrite = {
    kind: "submitPending",
    review: "PRR_1" as never,
    event: "approve",
    body: "",
  };
  for (const [at, write] of [
    [one, { kind: "comment", pull: pull(2).id, body: "Hi" }],
    [one, { kind: "reply", thread: "PRRT_2", body: "Hi" }],
    [one, { kind: "resolve", thread: "PRRT_2" }],
    [two, pending],
    [three, { kind: "comment", pull: "PR_3" as never, body: "Hi" }],
  ] as const)
    expect(writes.send(at, write), JSON.stringify(write)).toBe("notInRead");
  expect(asked("write")).toBe(0);
  expect(writes.send(one, { kind: "resolve", thread: "PRRT_1" })).toBe(
    "started",
  );
  await vi.waitFor(() => expect(writes.busy(one)).toBe(false));
  expect(writes.send(one, pending)).toBe("started");
  expect(writes.send(two, said("Hi", 2))).toBe("started");
  await vi.waitFor(() => expect(asked("write")).toBe(3));
});

it("listens to the reads and the drafts only while something listens to it", async () => {
  const { host, details, drafts } = await window();
  let listening = 0;
  const counted =
    (subscribe: (listener: () => void) => () => void) =>
    (listener: () => void) => {
      listening += 1;
      const stop = subscribe(listener);
      return () => {
        listening -= 1;
        stop();
      };
    };
  const writes = createPullRequestWrites({
    host,
    details: { read: details.read, subscribe: counted(details.subscribe) },
    reread: () => {},
    drafts: { ...drafts, subscribe: counted(drafts.subscribe) },
    task: () => () => {},
  });
  expect(listening, "a store nobody shows").toBe(0);
  const stop = writes.subscribe(() => {});
  const also = writes.subscribe(() => {});
  expect(listening).toBeGreaterThan(0);
  stop();
  also();
  expect(listening, "a store dropped with its sign-in").toBe(0);
});
