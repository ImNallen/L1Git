import { expect, it, vi } from "vitest";
import type { HostRequest } from "./domain/host";
import { createHostClient } from "./host";
import { createPullRequests, stamp } from "./pullRequests";

const signedOut = (revision: number, ended: unknown = null) => ({
  revision,
  github: { kind: "notConnected", ended },
  deviceSignIn: false,
  deviceCode: null,
});
const signedIn = (revision: number, login = "octo", connectedAt = 1) => ({
  revision,
  github: {
    kind: "connected",
    login,
    api: "https://api.github.com/",
    method: "gh",
    access: "private",
    connectedAt,
  },
  deviceSignIn: false,
  deviceCode: null,
});
const revoked = {
  kind: "signedOut",
  message: "GitHub no longer accepts L1 Git's sign-in.",
  status: signedOut(2, { login: "octo", reason: "revoked" }),
};

/** `total` tells one answer from another. */
const rows = (total: number, status: unknown = signedIn(1)) => ({
  op: "pullRequests",
  data: { items: [], total },
  status,
});
const pull = (number: number) => ({
  op: "pullRequest",
  data: {
    id: `PR_${number}`,
    repositoryId: "R_1",
    number,
    title: "Fix it",
    body: "",
    state: { kind: "open", draft: false },
    author: "hubot",
    viewerIsAuthor: false,
    viewerPermission: "write",
    base: "main",
    baseOid: "b".repeat(40),
    labels: { items: [], total: 0 },
    additions: 1,
    deletions: 2,
    changedFiles: 1,
    createdAt: "2026-11-24T16:23:14Z",
    updatedAt: "2026-11-24T16:23:14Z",
    head: {
      branch: "fix",
      oid: "1".repeat(40),
      repository: null,
      crossRepository: false,
      maintainerCanModify: false,
      ref: null,
    },
    reviewers: [],
    reviewed: null,
    checks: null,
    commits: { items: [], total: 0 },
    timeline: { items: [], total: 0 },
    threads: { items: [], total: 0 },
    mergeable: "unknown",
    mergeState: "unknown",
    decision: null,
    merge: {
      allowed: { merge: true, squash: false, rebase: false },
      preferred: "merge",
      deletesBranch: false,
    },
    pending: { kind: "unknown" },
  },
  status: signedIn(1),
});

const open = (repo: string) => ({
  repository: { owner: "octo", repo },
  list: "open" as const,
});
const empty = {
  value: null,
  at: null,
  askedAt: null,
  reading: false,
  problem: null,
};

function setup() {
  const replies: {
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  }[] = [];
  const transport = vi.fn<(request: HostRequest) => Promise<unknown>>(
    () =>
      new Promise((resolve, reject) => {
        replies.push({ resolve, reject });
      }),
  );
  const host = createHostClient(transport);
  const { lists, details } = createPullRequests(host);
  return { host, lists, details, transport, replies };
}

async function connected() {
  const world = setup();
  const status = world.host.refresh();
  world.replies[0]?.resolve({ op: "status", status: signedIn(1) });
  await status;
  return world;
}

async function holding(total: number) {
  const world = await connected();
  const read = world.lists.refresh(open("app"));
  world.replies[1]?.resolve(rows(total));
  await read;
  return world;
}

async function becomes(
  { host, transport, replies }: ReturnType<typeof setup>,
  status: ReturnType<typeof signedIn> | ReturnType<typeof signedOut>,
) {
  const call =
    status.github.kind === "connected"
      ? host.connectGh("hubot")
      : host.disconnect();
  const op = status.github.kind === "connected" ? "connectGh" : "disconnect";
  replies[transport.mock.calls.length - 1]?.resolve({ op, status });
  await call;
}

it("keeps repositories apart, whatever order they answer in", async () => {
  const { lists, replies } = await connected();
  const first = lists.refresh(open("first"));
  const second = lists.refresh(open("second"));
  replies[2]?.resolve(rows(22));
  replies[1]?.resolve(rows(11));
  await Promise.all([first, second]);
  expect(lists.read()(open("first")).value?.total).toBe(11);
  expect(lists.read()(open("second")).value?.total).toBe(22);
  expect(lists.read()({ ...open("first"), list: "recentlyMerged" })).toEqual(
    empty,
  );
});

it("joins a running read of the same repository in any letter case", async () => {
  const { lists, transport, replies } = await connected();
  const first = lists.refresh(open("app"));
  const again = lists.refresh(open("App"));
  expect(transport).toHaveBeenCalledTimes(2);
  replies[1]?.resolve(rows(5));
  await Promise.all([first, again]);
  expect(lists.read()(open("APP")).value?.total).toBe(5);
  void lists.refresh(open("app"));
  expect(transport).toHaveBeenCalledTimes(3);
});

it("keeps the last value while reading and after a failure, until a success", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(5_000);
  const { lists, replies } = await holding(5);
  now.mockReturnValue(12_000);
  const failing = lists.refresh(open("app"));
  expect(lists.read()(open("app"))).toMatchObject({
    reading: true,
    value: { total: 5 },
  });
  replies[2]?.reject({
    kind: "rateLimited",
    resetAt: 9,
    message: "GitHub's rate limit for your account is used up.",
    status: signedIn(1),
  });
  await failing;
  expect(lists.read()(open("app"))).toMatchObject({
    reading: false,
    value: { total: 5 },
    at: 5_000,
    problem: { kind: "rateLimited", resetAt: 9 },
  });

  const unreachable = lists.refresh(open("app"));
  replies[3]?.reject(new Error("The development bridge is unavailable."));
  await unreachable;
  expect(lists.read()(open("app"))).toMatchObject({
    value: { total: 5 },
    problem: { kind: "transport" },
  });

  const succeeding = lists.refresh(open("app"));
  replies[4]?.resolve(rows(6));
  await succeeding;
  expect(lists.read()(open("app"))).toEqual({
    value: { items: [], total: 6 },
    at: 12_000,
    askedAt: expect.any(Number),
    reading: false,
    problem: null,
  });
  now.mockRestore();
});

it("stamps a value with when its read was asked, and keeps that stamp through a failure", async () => {
  const { details, replies } = await connected();
  const of = { repository: { owner: "octo", repo: "app" }, number: 12 };
  const first = details.refresh(of);
  const answered = stamp();
  replies[1]?.resolve(pull(12));
  await first;
  const asked = details.read()(of).askedAt ?? Infinity;
  expect(asked, "asked before the answer it races").toBeLessThan(answered);
  const failing = details.refresh(of);
  replies[2]?.reject(new Error("The development bridge is unavailable."));
  await failing;
  expect(details.read()(of).askedAt).toBe(asked);
  const again = details.refresh(of);
  replies[3]?.resolve(pull(12));
  await again;
  expect(details.read()(of).askedAt).toBeGreaterThan(answered);
});

it("gives a new snapshot only when an answer changes, and tells its listeners", async () => {
  const { lists, details, replies } = await connected();
  const heardList = vi.fn();
  const heardDetail = vi.fn();
  lists.subscribe(heardList);
  details.subscribe(heardDetail);
  const before = lists.read();
  expect(lists.read()).toBe(before);

  const read = lists.refresh(open("app"));
  const reading = lists.read();
  expect(reading).not.toBe(before);
  expect(heardList).toHaveBeenCalledTimes(1);
  replies[1]?.resolve(rows(5));
  await read;
  expect(lists.read()).not.toBe(reading);
  expect(heardList).toHaveBeenCalledTimes(2);
  expect(heardDetail).not.toHaveBeenCalled();
});

it("reads single pull requests by number", async () => {
  const { details, transport, replies } = await connected();
  const of = (number: number) => ({
    repository: { owner: "octo", repo: "app" },
    number,
  });
  const seven = details.refresh(of(7));
  const eight = details.refresh(of(8));
  expect(transport).toHaveBeenLastCalledWith({ op: "pullRequest", ...of(8) });
  replies[2]?.resolve(pull(8));
  replies[1]?.resolve(pull(7));
  await Promise.all([seven, eight]);
  expect(details.read()(of(7)).value?.number).toBe(7);
  expect(details.read()(of(8)).value?.number).toBe(8);
});

it("asks nothing while signed out or before the status is known", async () => {
  const unknown = setup();
  await unknown.lists.refresh(open("app"));
  expect(unknown.transport).not.toHaveBeenCalled();

  const world = await connected();
  await becomes(world, signedOut(2));
  await world.lists.refresh(open("app"));
  expect(world.transport).toHaveBeenCalledTimes(2);
  expect(world.lists.read()(open("app"))).toEqual(empty);
});

it("empties everything, and signs Settings out, when a read finds the token revoked", async () => {
  const world = await holding(5);
  const { host, lists, replies } = world;
  const shown: unknown[] = [];
  const look = () => {
    if (host.read().status?.github.kind === "notConnected")
      shown.push(lists.read()(open("app")));
  };
  host.subscribe(look);
  lists.subscribe(look);
  const other = lists.refresh(open("other"));
  replies[2]?.reject(revoked);
  await other;
  expect(host.read().status).toEqual(revoked.status);
  expect(shown.length).toBeGreaterThan(0);
  expect(shown).toEqual(shown.map(() => empty));
  expect(lists.read()(open("other"))).toEqual(empty);
});

it("drops an answer that arrives after a disconnect", async () => {
  const world = await connected();
  const late = world.lists.refresh(open("app"));
  await becomes(world, signedOut(2));
  world.replies[1]?.resolve(rows(5));
  await late;
  expect(world.lists.read()(open("app"))).toEqual(empty);
});

it("drops an answer for another account, also while this one reads the same list", async () => {
  const world = await connected();
  const { lists, replies } = world;
  const late = lists.refresh(open("app"));
  await becomes(world, signedIn(3, "hubot"));
  const mine = lists.refresh(open("app"));
  replies[1]?.resolve(rows(5));
  await late;
  expect(lists.read()(open("app"))).toEqual({ ...empty, reading: true });
  replies[3]?.resolve(rows(9, signedIn(3, "hubot")));
  await mine;
  expect(lists.read()(open("app")).value?.total).toBe(9);
});

it("drops an answer that came with the status of a newer sign-in", async () => {
  const { lists, replies } = await holding(5);
  const read = lists.refresh(open("app"));
  replies[2]?.resolve(rows(6, signedIn(2, "octo", 2)));
  await read;
  expect(lists.read()(open("app"))).toEqual(empty);
});

it("ends one subscription without ending another of the same listener", async () => {
  const world = await connected();
  const heard = vi.fn();
  const stop = world.lists.subscribe(heard);
  world.details.subscribe(heard);
  stop();
  await becomes(world, signedOut(2));
  expect(heard).toHaveBeenCalled();
  const other = vi.fn();
  world.lists.subscribe(other)();
  await becomes(world, signedIn(3));
  void world.lists.refresh(open("app"));
  expect(other).not.toHaveBeenCalled();
});
