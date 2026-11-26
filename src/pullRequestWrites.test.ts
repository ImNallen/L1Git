import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { hostRoute } from "./domain/host";
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
import { pull } from "./test/pullRequests";
import { send } from "./transport";

const HEAD = "1".repeat(40) as Oid;
const repository = { owner: "octo", repo: "pin" };
const one: PullOf = { repository, number: 1 };
const two: PullOf = { repository, number: 2 };
const conversation: Anchor = { kind: "conversation" };
const said = (body: string): PullWrite => ({
  kind: "comment",
  pull: pull(1).id,
  body,
});

let bridge: Bridge;
beforeEach(() => {
  bridge = createBridge();
  vi.stubGlobal("fetch", bridge.fetch);
  const { host } = bridge.world;
  host.details.set(pullKey("octo/pin", 1), pull(1));
  host.details.set(pullKey("octo/pin", 2), pull(2));
  host.status = {
    ...host.status,
    github: {
      kind: "connected",
      login: "octo",
      api: "https://api.github.com/",
      method: "gh",
      access: "private",
      connectedAt: 1,
    },
  };
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
  return { host, details, drafts, writes, read };
}

const sent = () => bridge.hostLog.filter(({ op }) => op === "write").length;
const reads = () =>
  bridge.hostLog.filter(({ op }) => op === "pullRequest").length;
const state = (writes: Awaited<ReturnType<typeof window>>["writes"]) =>
  writes.attempts(one).at(-1)?.state;

it("sends one write per pull request at a time and answers busy to the next", async () => {
  const { writes } = await window();
  const answer = bridge.hold("write");
  expect(writes.send(one, said("First"))).toBe("started");
  expect(writes.send(one, said("Second"))).toBe("busy");
  expect(writes.send(two, said("Elsewhere")), "its own lane").toBe("started");
  await answer.arrived;
  expect(writes.busy(one)).toBe(true);
  answer.release();
  await vi.waitFor(() => expect(state(writes)?.kind).toBe("settled"));
  expect(sent()).toBe(2);
  expect(writes.attempts(one).map(({ write }) => write)).toEqual([
    said("First"),
  ]);
  expect(writes.send(one, said("Second"))).toBe("started");
});

it("keeps a done write's words until a read asked after its answer has them, and deletes its draft at once", async () => {
  const { writes, drafts, details } = await window();
  const of = { login: "octo", ...one };
  drafts.type(of, conversation, HEAD, "Thanks!");
  await drafts.flush(of);
  const reread = bridge.hold("pullRequest");
  writes.send(one, said("Thanks!"), [{ anchor: conversation, head: HEAD }]);
  await reread.arrived;
  expect(state(writes)).toMatchObject({ kind: "done" });
  expect(writes.busy(one), "a done write holds nothing back").toBe(false);
  await vi.waitFor(() =>
    expect(bridge.world.host.drafts.get("octo octo/pin#1")).toEqual([]),
  );
  reread.release();
  await vi.waitFor(() =>
    expect(state(writes)).toEqual({
      kind: "settled",
      landed: true,
      after: "done",
    }),
  );
  const timeline = details.read()(one).value?.timeline.items ?? [];
  expect(timeline.at(-1)).toMatchObject({ kind: "comment", body: "Thanks!" });
});

it("holds the lane while the outcome is unknown, and trusts only a read asked after the answer", async () => {
  const { writes, drafts, read } = await window();
  const of = { login: "octo", ...one };
  drafts.type(of, conversation, HEAD, "Thanks!");
  await drafts.flush(of);
  const early = bridge.hold("pullRequest");
  read(1);
  await early.arrived;
  bridge.world.host.writes.push({ kind: "unknown", applied: true });
  writes.send(one, said("Thanks!"), [{ anchor: conversation, head: HEAD }]);
  await vi.waitFor(() => expect(state(writes)?.kind).toBe("unknown"));
  expect(writes.send(one, said("Again?"))).toBe("busy");
  const fresh = bridge.hold("pullRequest");
  early.release();
  await fresh.arrived;
  expect(state(writes)?.kind, "the early read shows it, and is older").toBe(
    "unknown",
  );
  fresh.release();
  await vi.waitFor(() =>
    expect(state(writes)).toEqual({
      kind: "settled",
      landed: true,
      after: "unknown",
    }),
  );
  expect(reads()).toBe(2);
  expect(sent(), "never sent again").toBe(1);
  await vi.waitFor(() =>
    expect(bridge.world.host.drafts.get("octo octo/pin#1")).toEqual([]),
  );
});

it("frees the lane and keeps the draft when a read shows an unknown write did not land", async () => {
  const { writes, drafts } = await window();
  const of = { login: "octo", ...one };
  drafts.type(of, conversation, HEAD, "Thanks!");
  await drafts.flush(of);
  bridge.world.host.writes.push({ kind: "unknown", applied: false });
  writes.send(one, said("Thanks!"), [{ anchor: conversation, head: HEAD }]);
  await vi.waitFor(() =>
    expect(state(writes)).toEqual({
      kind: "settled",
      landed: false,
      after: "unknown",
    }),
  );
  expect(writes.busy(one)).toBe(false);
  expect(bridge.world.host.drafts.get("octo octo/pin#1")).toMatchObject([
    { text: "Thanks!" },
  ]);
});

it("tells refused from not sent, rereads only after GitHub answered, and clears either notice", async () => {
  const { writes } = await window();
  bridge.world.host.writes.push(
    {
      kind: "refused",
      message: "GitHub didn't do it: Pull request is locked.",
    },
    { kind: "notSent", message: "L1 Git sent nothing." },
  );
  writes.send(one, said("One"));
  await vi.waitFor(() => expect(state(writes)?.kind).toBe("refused"));
  expect(state(writes)).toMatchObject({ message: /locked/ });
  await vi.waitFor(() => expect(reads()).toBe(1));
  writes.send(one, said("Two"));
  await vi.waitFor(() => expect(state(writes)?.kind).toBe("notSent"));
  expect(reads()).toBe(1);
  for (const { id } of writes.attempts(one)) writes.dismiss(one, id);
  expect(writes.attempts(one)).toEqual([]);
});

it("sends nothing while signed out, while an update waits to restart, or for another sign-in's lane", async () => {
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
  await vi.waitFor(() => expect(bridge.active()).toBe(0));
  expect(writes.attempts(one), "an old sign-in's answer stays out").toEqual([]);
  expect(sent()).toBe(1);
});
