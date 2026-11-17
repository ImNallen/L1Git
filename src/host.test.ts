import { afterEach, expect, it, vi } from "vitest";
import type { HostRequest } from "./domain/host";
import { createHostClient } from "./host";

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
