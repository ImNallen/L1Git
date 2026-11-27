// @vitest-environment happy-dom
import { act, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Anchor } from "../domain/drafts";
import { hostRoute } from "../domain/host";
import type { HostStatus } from "../domain/host";
import type { Oid } from "../domain/repository";
import { createHostClient } from "../host";
import { createPullRequests, signIn } from "../pullRequests";
import { createBridge, pullKey } from "../test/fakeBridge";
import type { Bridge } from "../test/fakeBridge";
import { pull } from "../test/pullRequests";
import { send } from "../transport";
import { usePullDrafts, usePullWrites, usePullWriting } from "./usePullWriting";
import type { PullWriting } from "./usePullWriting";

const HEAD = "1".repeat(40) as Oid;
const repository = { owner: "octo", repo: "pin" };
const conversation: Anchor = { kind: "conversation" };
const connected = (connectedAt: number): HostStatus["github"] => ({
  kind: "connected",
  login: "octo",
  api: "https://api.github.com/",
  method: "gh",
  access: "private",
  connectedAt,
});

let bridge: Bridge;
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let host: ReturnType<typeof createHostClient>;
let details: ReturnType<typeof createPullRequests>["details"];
let rendered: (PullWriting | null)[];
let screen: {
  drafts: ReturnType<typeof usePullDrafts>;
  writes: ReturnType<typeof usePullWrites>;
} | null;

function Screen({ writing }: { writing: PullWriting }) {
  const opened = {
    writing,
    viewer: "octo",
    repository: { github: repository },
    number: 1,
  };
  screen = { drafts: usePullDrafts(opened), writes: usePullWrites(opened) };
  return null;
}

function Shell() {
  const { status } = useSyncExternalStore(host.subscribe, host.read);
  const writing = usePullWriting({
    host,
    details,
    account: signIn(status),
    reread: () => {},
    opened: { login: "octo", repository, number: 1 },
  });
  rendered.push(writing);
  return writing && <Screen writing={writing} />;
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  bridge = createBridge();
  vi.stubGlobal("fetch", bridge.fetch);
  bridge.world.host.details.set(pullKey("octo/pin", 1), pull(1));
  bridge.world.host.status = {
    ...bridge.world.host.status,
    github: connected(1),
  };
  host = createHostClient((request) => send(hostRoute, request));
  await host.refresh();
  details = createPullRequests(host).details;
  rendered = [];
  screen = null;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Shell />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("keeps one drafts store and one writes store per sign-in, and none while signed out", async () => {
  const first = rendered.at(-1);
  expect(first).not.toBeNull();
  await act(async () => root.render(<Shell />));
  expect(rendered.at(-1), "another render keeps them").toBe(first);

  await act(() => host.disconnect());
  expect(rendered.at(-1), "signing out drops them").toBeNull();

  bridge.world.host.status = {
    ...bridge.world.host.status,
    github: connected(2),
  };
  await act(() => host.refresh());
  const second = rendered.at(-1);
  expect(second).not.toBeNull();
  expect(second?.drafts).not.toBe(first?.drafts);
  expect(second?.writes).not.toBe(first?.writes);
});

it("saves waiting drafts as soon as the window loses focus", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await act(async () => screen?.drafts.type(conversation, HEAD, "Looks good"));
  expect(screen?.drafts.drafts[0]?.save.kind).toBe("saving");

  await act(async () => window.dispatchEvent(new Event("blur")));
  // Waits behind the save the blur started, while the typing timer never fires.
  await act(() =>
    rendered.at(-1)?.drafts.load({ login: "octo", repository, number: 1 }),
  );
  expect(screen?.drafts.drafts[0]?.save.kind).toBe("saved");
  expect(bridge.world.host.drafts.get("octo octo/pin#1")).toMatchObject([
    { text: "Looks good" },
  ]);
});

it("saves the drafts a write carries before it sends them", async () => {
  await act(() => details.refresh({ repository, number: 1 }));
  await act(async () => screen?.drafts.type(conversation, HEAD, "Thanks!"));
  let sent: string | undefined;
  await act(async () => {
    sent = await screen?.writes.send(
      { kind: "comment", pull: pull(1).id, body: "Thanks!" },
      [{ anchor: conversation, head: HEAD }],
    );
  });
  expect(sent).toBe("started");
  await vi.waitFor(() => expect(bridge.world.host.mutations).toHaveLength(1));
});

it("reads the drafts again every 5 seconds while it shows another window's write as sending", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const book = "octo octo/pin#1";
  const write = { kind: "comment" as const, pull: pull(1).id, body: "From A" };
  const record = {
    attempt: "elsewhere",
    at: 1,
    write,
    drafts: [],
    sending: true,
    applied: false,
  };
  bridge.world.host.sent.set(book, [record]);
  await act(() =>
    rendered.at(-1)?.drafts.load({ login: "octo", repository, number: 1 }),
  );
  expect(screen?.writes.attempts.map(({ state }) => state.kind)).toEqual([
    "sending",
  ]);
  const reads = () =>
    bridge.hostLog.filter(
      (request) =>
        request.op === "drafts" &&
        (request.change as { kind: string }).kind === "read",
    ).length;

  bridge.world.host.sent.set(book, [{ ...record, sending: false }]);
  await act(async () => vi.advanceTimersByTime(4_000));
  expect(screen?.writes.attempts.map(({ state }) => state.kind)).toEqual([
    "sending",
  ]);
  await act(async () => vi.advanceTimersByTime(1_000));
  await vi.waitFor(() =>
    expect(screen?.writes.attempts.map(({ state }) => state.kind)).toEqual([
      "unknown",
    ]),
  );
  const after = reads();
  await act(async () => vi.advanceTimersByTime(20_000));
  expect(reads(), "nothing shown as sending, so no more reads").toBe(after);
});
