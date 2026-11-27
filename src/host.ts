import { useEffect, useState, useSyncExternalStore } from "react";
import { hostErrorSchema, hostResponseSchema, hostRoute } from "./domain/host";
import type {
  GhProbe,
  HostCheck,
  HostCommand,
  HostDrafts,
  HostProblem,
  HostRead,
  HostRequest,
  HostResponse,
  HostSendAgain,
  HostStatus,
  HostWrite,
  Wrote,
} from "./domain/host";
import { Unsent, send } from "./transport";

type Op = HostCommand["op"];
type Busy = Exclude<Op, "status" | "devicePoll">;
type HostView = {
  status: HostStatus | null;
  probe: GhProbe | null;
  busy: Busy | null;
  problem: string | null;
};
type HostTransport = (request: HostRequest) => Promise<unknown>;
type Reply<R extends HostRequest> = Extract<HostResponse, { op: R["op"] }>;
type Exchanged<R extends HostRequest> =
  | { ok: true; reply: Reply<R> }
  | { ok: false; problem: HostProblem };

function answers<R extends HostRequest>(
  request: R,
  response: HostResponse,
): response is Reply<R> {
  return response.op === request.op;
}

const transportProblem = (error: unknown) =>
  error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "L1 Git could not reach its GitHub connection. Try again.";

const unreachableRetryMs = 5_000;

const unheard =
  "L1 Git sent this to its GitHub connection and did not hear back, so GitHub may or may not have done it.";

export function createHostClient(transport: HostTransport) {
  let view: HostView = {
    status: null,
    probe: null,
    busy: null,
    problem: null,
  };
  const running = new Map<Op, Promise<boolean>>();
  const listeners = new Set<() => void>();
  let poll: ReturnType<typeof setTimeout> | undefined;
  let announced: number | undefined;
  function update(next: Partial<HostView>) {
    view = { ...view, ...next };
    announced = view.status?.revision;
    listeners.forEach((listener) => listener());
  }
  function schedulePoll(minimumMs = 0) {
    clearTimeout(poll);
    const prompt = view.status?.deviceCode;
    if (prompt)
      poll = setTimeout(
        () => void runOnce({ op: "devicePoll", session: prompt.session }),
        Math.max(prompt.pollAfterMs, minimumMs),
      );
  }
  function accept(status: HostStatus) {
    if (view.status && status.revision < view.status.revision) return;
    view = { ...view, status };
    schedulePoll();
  }
  function busy() {
    return (
      [...running.keys()].findLast(
        (op): op is Busy => op !== "status" && op !== "devicePoll",
      ) ?? null
    );
  }

  /** Every reply carries the status, so every request takes it from here. */
  async function exchange<R extends HostRequest>(
    request: R,
  ): Promise<Exchanged<R>> {
    try {
      const response = hostResponseSchema.parse(await transport(request));
      if (!answers(request, response))
        throw new Error(
          `L1 Git asked for ${request.op} and got an answer for ${response.op}. Try again.`,
        );
      accept(response.status);
      return { ok: true, reply: response };
    } catch (error) {
      const failure = hostErrorSchema.safeParse(error);
      if (!failure.success)
        return {
          ok: false,
          problem: {
            kind: "transport",
            message: transportProblem(error),
            ...(error instanceof Unsent && { unsent: true }),
          },
        };
      accept(failure.data.status);
      return { ok: false, problem: failure.data };
    }
  }

  function runOnce(body: HostCommand): Promise<boolean> {
    const current = running.get(body.op);
    if (current) return current;
    const call = exchange(body)
      .then((outcome) => {
        if (outcome.ok) {
          if (outcome.reply.op === "probeGh")
            view = { ...view, probe: outcome.reply.data };
          return true;
        }
        const { kind, message } = outcome.problem;
        const explained = kind === "signedOut" || kind === "notConnected";
        view = { ...view, problem: explained ? null : message };
        if (kind === "transport" && body.op === "devicePoll")
          schedulePoll(unreachableRetryMs);
        return false;
      })
      .finally(() => {
        running.delete(body.op);
        update({ busy: busy() });
      });
    running.set(body.op, call);
    update({ busy: busy(), problem: null });
    return call;
  }

  /**
   * Asks GitHub, or the drafts on this computer, through Rust. It leaves
   * `busy` and `problem` to the sign-in screen, but takes the status like any
   * request, so a token GitHub refuses here signs that screen out too.
   */
  async function ask<R extends HostRead | HostDrafts | HostCheck>(
    request: R,
  ): Promise<Exchanged<R>> {
    const exchanged = await exchange(request);
    if (view.status?.revision !== announced) update({});
    return exchanged;
  }

  /**
   * Sends one write to GitHub through Rust. Unlike `ask` and `runOnce`, it
   * never joins another request, and nothing here sends it again. An answer
   * that never came back from Rust may follow GitHub doing it, so it is
   * unknown, unless the request never got to Rust.
   */
  async function write(request: HostWrite | HostSendAgain): Promise<Wrote> {
    const exchanged = await exchange<HostWrite | HostSendAgain>(request);
    if (view.status?.revision !== announced) update({});
    if (exchanged.ok) return exchanged.reply.data;
    const { problem } = exchanged;
    const unsent = problem.kind === "transport" && problem.unsent;
    return {
      written: unsent
        ? {
            kind: "notSent",
            message: `L1 Git sent nothing. ${problem.message}`,
          }
        : { kind: "unknown", message: unheard },
      drafts: null,
    };
  }

  function cancelDevice(): Promise<boolean> {
    const starting = running.get("deviceStart");
    if (starting) return starting.then(cancelDevice);
    const prompt = view.status?.deviceCode;
    return prompt
      ? runOnce({ op: "deviceCancel", session: prompt.session })
      : Promise.resolve(true);
  }

  return {
    read: () => view,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    ask,
    write: (request: Omit<HostWrite, "op">) =>
      write({ op: "write", ...request }),
    sendAgain: (request: Omit<HostSendAgain, "op">) =>
      write({ op: "sendAgain", ...request }),
    refresh: () => runOnce({ op: "status" }),
    probeGh: () => runOnce({ op: "probeGh" }),
    connectGh: (login: string) => runOnce({ op: "connectGh", login }),
    verify: () => runOnce({ op: "verify" }),
    disconnect: () => runOnce({ op: "disconnect" }),
    startDevice: () => runOnce({ op: "deviceStart" }),
    cancelDevice,
    dismiss: () => update({ probe: null, problem: null }),
    dispose: () => clearTimeout(poll),
  };
}

export function useHost() {
  const [client] = useState(() =>
    createHostClient((request) => send(hostRoute, request)),
  );
  const view = useSyncExternalStore(client.subscribe, client.read, client.read);
  useEffect(() => {
    void client.refresh();
    return client.dispose;
  }, [client]);
  return { ...view, ...client };
}
export type Host = ReturnType<typeof useHost>;
export type HostClient = ReturnType<typeof createHostClient>;
