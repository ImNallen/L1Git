import { expect, it, vi } from "vitest";
import type { HostRequest } from "./domain/host";
import { createHostClient } from "./host";

const notConnected = (revision: number, ended: unknown = null) => ({
  revision,
  github: { kind: "notConnected", ended },
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
