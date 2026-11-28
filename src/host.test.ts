import { afterEach, expect, it, vi } from "vitest";
import type { HostRequest } from "./domain/host";
import { createHostClient } from "./host";
import { Unsent } from "./transport";

const notConnected = (revision: number, ended: unknown = null) => ({
  revision,
  github: { kind: "notConnected", ended },
  deviceSignIn: false,
  deviceCode: null,
});
const connected = (revision: number) => ({
  revision,
  github: {
    kind: "connected",
    login: "octo",
    api: "https://api.github.com/",
    method: "gh",
    access: "private",
    connectedAt: 1_700_000_000,
  },
  deviceSignIn: false,
  deviceCode: null,
});
const waiting = (revision: number, pollAfterMs: number) => ({
  ...notConnected(revision),
  deviceSignIn: true,
  deviceCode: {
    session: "s1",
    userCode: "WDJB-MJHT",
    verificationUri: "https://github.com/login/device",
    expiresInMs: 899_000,
    pollAfterMs,
  },
});

function deferred() {
  let resolve: (value: unknown) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<unknown>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function client() {
  const replies: ReturnType<typeof deferred>[] = [];
  const transport = vi.fn<(request: HostRequest) => Promise<unknown>>(() => {
    const reply = deferred();
    replies.push(reply);
    return reply.promise;
  });
  return { host: createHostClient(transport), transport, replies };
}

it("keeps the newest status when an older reply arrives late", async () => {
  const { host, replies } = client();
  const status = host.refresh();
  const disconnect = host.disconnect();
  await Promise.resolve();
  replies[1]?.resolve({ op: "disconnect", status: notConnected(3) });
  await disconnect;
  replies[0]?.resolve({ op: "status", status: connected(2) });
  await status;
  expect(host.read().status).toEqual(notConnected(3));
  const verify = host.verify();
  await Promise.resolve();
  replies[2]?.resolve({ op: "verify", status: connected(3) });
  await verify;
  expect(host.read().status).toEqual(connected(3));
});

it("takes the status a failure carries and explains an ended sign-in through it alone", async () => {
  const { host, replies } = client();
  const verify = host.verify();
  await Promise.resolve();
  replies[0]?.reject({
    kind: "signedOut",
    message: "GitHub no longer accepts L1 Git's sign-in.",
    status: notConnected(5, { login: "octo", reason: "revoked" }),
  });
  expect(await verify).toBe(false);
  expect(host.read()).toMatchObject({
    status: notConnected(5, { login: "octo", reason: "revoked" }),
    problem: null,
    busy: null,
  });
});

it("shows Rust's message for a failure and the transport's for a broken bridge", async () => {
  const { host, replies } = client();
  const connect = host.connectGh("octo");
  await Promise.resolve();
  replies[0]?.reject({
    kind: "keychain",
    problem: "locked",
    message: "Unlock the system keychain, then try again.",
    status: notConnected(2),
  });
  await connect;
  expect(host.read().problem).toBe(
    "Unlock the system keychain, then try again.",
  );
  const probe = host.probeGh();
  await Promise.resolve();
  expect(host.read().problem).toBeNull();
  replies[1]?.reject(new Error("The development bridge is unavailable."));
  await probe;
  expect(host.read().problem).toBe("The development bridge is unavailable.");
});

it("sends one connect for a double click and resolves both clicks", async () => {
  const { host, transport, replies } = client();
  const first = host.connectGh("octo");
  const second = host.connectGh("octo");
  expect(host.read().busy).toBe("connectGh");
  await Promise.resolve();
  expect(transport).toHaveBeenCalledExactlyOnceWith({
    op: "connectGh",
    login: "octo",
  });
  replies[0]?.resolve({ op: "connectGh", status: connected(4) });
  expect(await Promise.all([first, second])).toEqual([true, true]);
  expect(host.read()).toMatchObject({ status: connected(4), busy: null });
  void host.connectGh("octo");
  await Promise.resolve();
  expect(transport).toHaveBeenCalledTimes(2);
});

it("reports an answer to another request instead of applying it", async () => {
  const { host, replies } = client();
  const disconnect = host.disconnect();
  await Promise.resolve();
  replies[0]?.resolve({ op: "verify", status: connected(9) });
  expect(await disconnect).toBe(false);
  expect(host.read().status).toBeNull();
  expect(host.read().problem).toBe(
    "L1 Git asked for disconnect and got an answer for verify. Try again.",
  );
});

it("keeps the probe until the dialog dismisses it", async () => {
  const { host, replies } = client();
  const probe = host.probeGh();
  await Promise.resolve();
  replies[0]?.resolve({
    op: "probeGh",
    data: { kind: "signedOut" },
    status: notConnected(1),
  });
  await probe;
  expect(host.read().probe).toEqual({ kind: "signedOut" });
  host.dismiss();
  expect(host.read().probe).toBeNull();
});

afterEach(() => {
  vi.useRealTimers();
});

it("polls a browser sign-in when Rust says to, and stops once it connects", async () => {
  vi.useFakeTimers();
  const { host, transport, replies } = client();
  const start = host.startDevice();
  await Promise.resolve();
  replies[0]?.resolve({ op: "deviceStart", status: waiting(2, 5_000) });
  await start;
  await vi.advanceTimersByTimeAsync(4_999);
  expect(transport).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(transport).toHaveBeenLastCalledWith({
    op: "devicePoll",
    session: "s1",
  });
  expect(host.read().busy).toBeNull();

  replies[1]?.resolve({ op: "devicePoll", status: waiting(3, 10_000) });
  await vi.advanceTimersByTimeAsync(9_999);
  expect(transport).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(transport).toHaveBeenCalledTimes(3);

  replies[2]?.resolve({ op: "devicePoll", status: connected(4) });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(transport).toHaveBeenCalledTimes(3);
  expect(host.read().status).toEqual(connected(4));
});

it("stops polling when a browser sign-in ends in an error or the client is disposed", async () => {
  vi.useFakeTimers();
  const { host, transport, replies } = client();
  void host.refresh();
  await Promise.resolve();
  replies[0]?.resolve({ op: "status", status: waiting(2, 0) });
  await vi.advanceTimersByTimeAsync(0);
  expect(transport).toHaveBeenCalledTimes(2);
  replies[1]?.reject({
    kind: "deviceExpired",
    message: "The sign-in code expired.",
    status: notConnected(3),
  });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(transport).toHaveBeenCalledTimes(2);
  expect(host.read().problem).toBe("The sign-in code expired.");

  void host.startDevice();
  await Promise.resolve();
  replies[2]?.resolve({ op: "deviceStart", status: waiting(4, 5_000) });
  await vi.advanceTimersByTimeAsync(0);
  host.dispose();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(transport).toHaveBeenCalledTimes(3);
});

it("cancels only a running browser sign-in, and stops its timer", async () => {
  vi.useFakeTimers();
  const { host, transport, replies } = client();
  expect(await host.cancelDevice()).toBe(true);
  expect(transport).not.toHaveBeenCalled();
  const start = host.startDevice();
  await Promise.resolve();
  replies[0]?.resolve({ op: "deviceStart", status: waiting(2, 5_000) });
  await start;
  const cancel = host.cancelDevice();
  await Promise.resolve();
  expect(transport).toHaveBeenLastCalledWith({
    op: "deviceCancel",
    session: "s1",
  });
  replies[1]?.resolve({ op: "deviceCancel", status: notConnected(3) });
  expect(await cancel).toBe(true);
  expect(host.read().status?.deviceCode).toBeNull();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(transport).toHaveBeenCalledTimes(2);
});

it("cancels a browser sign-in that is still starting once its session exists", async () => {
  vi.useFakeTimers();
  const { host, transport, replies } = client();
  void host.startDevice();
  await Promise.resolve();
  const cancel = host.cancelDevice();
  replies[0]?.resolve({ op: "deviceStart", status: waiting(2, 5_000) });
  await vi.advanceTimersByTimeAsync(0);
  expect(transport).toHaveBeenLastCalledWith({
    op: "deviceCancel",
    session: "s1",
  });
  replies[1]?.resolve({ op: "deviceCancel", status: notConnected(3) });
  expect(await cancel).toBe(true);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(transport).toHaveBeenCalledTimes(2);
});

it("keeps polling a browser sign-in after a poll fails to reach Rust", async () => {
  vi.useFakeTimers();
  const { host, transport, replies } = client();
  void host.startDevice();
  await Promise.resolve();
  replies[0]?.resolve({ op: "deviceStart", status: waiting(2, 0) });
  await vi.advanceTimersByTimeAsync(0);
  expect(transport).toHaveBeenCalledTimes(2);
  replies[1]?.reject(new Error("The development bridge is unavailable."));
  await vi.advanceTimersByTimeAsync(4_999);
  expect(transport).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(transport).toHaveBeenLastCalledWith({
    op: "devicePoll",
    session: "s1",
  });
  replies[2]?.resolve({ op: "devicePoll", status: connected(3) });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(transport).toHaveBeenCalledTimes(3);
  expect(host.read().problem).toBeNull();
});

const openIn = (repo: string) => ({
  op: "pullRequests" as const,
  repository: { owner: "octo", repo },
  list: "open" as const,
});
const rows = (total: number, revision: number) => ({
  op: "pullRequests",
  data: { items: [], total },
  status: connected(revision),
});

async function signedIn() {
  const fixture = client();
  const status = fixture.host.refresh();
  fixture.replies[0]?.resolve({ op: "status", status: connected(1) });
  await status;
  return fixture;
}

it("answers two repositories read at once with their own pull requests", async () => {
  const { host, replies } = await signedIn();
  const first = host.ask(openIn("first"));
  const second = host.ask(openIn("second"));
  replies[2]?.resolve(rows(22, 1));
  replies[1]?.resolve(rows(11, 1));
  expect(await first).toMatchObject({
    ok: true,
    reply: { data: { total: 11 } },
  });
  expect(await second).toMatchObject({
    ok: true,
    reply: { data: { total: 22 } },
  });
});

it("leaves busy and problem to the commands while reads run and fail", async () => {
  const { host, replies } = await signedIn();
  const verify = host.verify();
  replies[1]?.reject({
    kind: "unreachable",
    message: "L1 Git could not reach GitHub.",
    status: connected(1),
  });
  await verify;
  const before = host.read();
  expect(before.problem).toBe("L1 Git could not reach GitHub.");
  const read = host.ask(openIn("app"));
  expect(host.read()).toBe(before);
  replies[2]?.reject({
    kind: "notFound",
    message: "L1 Git can't find octo/app on GitHub.",
    status: connected(1),
  });
  expect(await read).toMatchObject({
    ok: false,
    problem: {
      kind: "notFound",
      message: "L1 Git can't find octo/app on GitHub.",
    },
  });
  expect(host.read()).toMatchObject({
    busy: null,
    problem: "L1 Git could not reach GitHub.",
  });
});

it("tells listeners about reads only when the status moved, and once", async () => {
  const { host, replies } = await signedIn();
  const heard = vi.fn();
  host.subscribe(heard);
  const reads = ["a", "b", "c"].map((repo) => host.ask(openIn(repo)));
  for (const reply of replies.slice(1)) reply.resolve(rows(0, 1));
  await Promise.all(reads);
  expect(heard).not.toHaveBeenCalled();

  const refused = ["a", "b", "c"].map((repo) => host.ask(openIn(repo)));
  for (const reply of replies.slice(4))
    reply.reject({
      kind: "signedOut",
      message: "GitHub no longer accepts L1 Git's sign-in.",
      status: notConnected(2, { login: "octo", reason: "revoked" }),
    });
  await Promise.all(refused);
  expect(heard).toHaveBeenCalledOnce();
  expect(host.read()).toMatchObject({
    status: notConnected(2, { login: "octo", reason: "revoked" }),
    problem: null,
  });
});

it("reports a read that never reached Rust and keeps the status", async () => {
  const { host, replies } = await signedIn();
  const read = host.ask(openIn("app"));
  replies[1]?.reject(new Error("The development bridge is unavailable."));
  expect(await read).toEqual({
    ok: false,
    problem: {
      kind: "transport",
      message: "The development bridge is unavailable.",
    },
  });
  expect(host.read().status).toEqual(connected(1));
});

it("keeps polling a browser sign-in when a read delivers a newer status", async () => {
  vi.useFakeTimers();
  const { host, transport, replies } = client();
  void host.startDevice();
  replies[0]?.resolve({ op: "deviceStart", status: waiting(2, 5_000) });
  await vi.advanceTimersByTimeAsync(0);
  void host.ask(openIn("app"));
  replies[1]?.reject({
    kind: "notConnected",
    message: "L1 Git is not connected to GitHub.",
    status: waiting(3, 2_000),
  });
  await vi.advanceTimersByTimeAsync(1_999);
  expect(transport).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(transport).toHaveBeenLastCalledWith({
    op: "devicePoll",
    session: "s1",
  });
});

it("sends every write on its own, calls one Rust never answered unknown, and one that never got to Rust not sent", async () => {
  const { host, transport, replies } = client();
  const write = {
    asLogin: "octo",
    repository: { owner: "octo", repo: "app" },
    number: 1,
    attempt: "a-1",
    write: { kind: "resolve", thread: "T_1" },
    drafts: [],
  } as const;
  const first = host.write(write);
  const second = host.write(write);
  await Promise.resolve();
  expect(transport, "never joined like runOnce").toHaveBeenCalledTimes(2);
  expect(transport.mock.calls[0]?.[0]).toEqual({ op: "write", ...write });
  const done = {
    written: {
      kind: "done",
      echo: { kind: "thread", id: "T_1", resolved: true },
    },
    drafts: null,
  };
  replies[0]?.resolve({ op: "write", data: done, status: connected(2) });
  replies[1]?.reject(new Error("The development bridge is unavailable."));
  expect(await first).toEqual(done);
  expect(await second).toMatchObject({
    written: { kind: "unknown" },
    drafts: null,
  });
  expect(host.read().status).toEqual(connected(2));
  const interrupted = host.write(write);
  await Promise.resolve();
  replies[2]?.reject({
    kind: "interrupted",
    message: "L1 Git stopped before GitHub answered.",
    status: connected(2),
  });
  expect(await interrupted).toMatchObject({ written: { kind: "unknown" } });
  const refused = host.sendAgain({ ...write, attempt: "a-1" });
  await Promise.resolve();
  expect(transport.mock.calls[3]?.[0]).toMatchObject({ op: "sendAgain" });
  replies[3]?.reject(
    new Unsent("The development bridge rejected the request. bad id"),
  );
  expect(await refused).toEqual({
    written: {
      kind: "notSent",
      message:
        "L1 Git sent nothing. The development bridge rejected the request. bad id",
    },
    drafts: null,
  });
  expect(transport).toHaveBeenCalledTimes(4);
});

it("opens a pull request on its own each time, and calls one whose answer was lost unknown", async () => {
  const { host, transport, replies } = client();
  const open = {
    asLogin: "octo",
    repository: { owner: "octo", repo: "app" },
    open: {
      repositoryId: "R_1",
      base: "main",
      head: "fix",
      title: "Fix it",
      body: "",
      draft: false,
    },
  };
  const first = host.openPull(open);
  const second = host.openPull(open);
  await Promise.resolve();
  expect(transport, "never joined like runOnce").toHaveBeenCalledTimes(2);
  expect(transport.mock.calls[0]?.[0]).toEqual({ op: "openPull", ...open });
  replies[0]?.resolve({
    op: "openPull",
    data: { kind: "done", number: 12 },
    status: connected(2),
  });
  replies[1]?.reject(new Error("The development bridge is unavailable."));
  expect(await first).toEqual({ kind: "done", number: 12 });
  expect(await second).toMatchObject({ kind: "unknown" });
  const unsent = host.openPull(open);
  await Promise.resolve();
  replies[2]?.reject(new Unsent("The development bridge rejected it."));
  expect(await unsent).toEqual({
    kind: "notSent",
    message: "L1 Git sent nothing. The development bridge rejected it.",
  });
  const context = host.ask({
    op: "openPullContext",
    repository: open.repository,
    head: "fix",
  });
  await Promise.resolve();
  const read = {
    repositoryId: "R_1",
    defaultBranch: "main",
    open: [{ number: 12, base: "main" }],
  };
  replies[3]?.resolve({
    op: "openPullContext",
    data: read,
    status: connected(2),
  });
  expect(await context).toMatchObject({ ok: true, reply: { data: read } });
  expect(transport).toHaveBeenCalledTimes(4);
});
