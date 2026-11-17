import { useEffect, useState, useSyncExternalStore } from "react";
import { hostErrorSchema, hostResponseSchema, hostRoute } from "./domain/host";
import type { GhProbe, HostRequest, HostStatus } from "./domain/host";
import { send } from "./transport";

type Op = HostRequest["op"];
type Busy = Exclude<Op, "status" | "devicePoll">;
type HostView = {
  status: HostStatus | null;
  probe: GhProbe | null;
  busy: Busy | null;
  problem: string | null;
};
type HostTransport = (request: HostRequest) => Promise<unknown>;

const transportProblem = (error: unknown) =>
  error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "L1 Git could not reach its GitHub connection. Try again.";

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
  function update(next: Partial<HostView>) {
    view = { ...view, ...next };
    listeners.forEach((listener) => listener());
  }
  function accept(status: HostStatus) {
    if (view.status && status.revision < view.status.revision) return;
    view = { ...view, status };
    clearTimeout(poll);
    const prompt = status.deviceCode;
    if (prompt)
      poll = setTimeout(
        () => void runOnce({ op: "devicePoll", session: prompt.session }),
        prompt.pollAfterMs,
      );
  }
  function busy() {
    return (
      [...running.keys()].findLast(
        (op): op is Busy => op !== "status" && op !== "devicePoll",
      ) ?? null
    );
  }

  function runOnce(body: HostRequest): Promise<boolean> {
    const current = running.get(body.op);
    if (current) return current;
    const call = Promise.resolve(body)
      .then(transport)
      .then((value) => {
        const response = hostResponseSchema.parse(value);
        if (response.op !== body.op)
          throw new Error(
            `L1 Git asked for ${body.op} and got an answer for ${response.op}. Try again.`,
          );
        accept(response.status);
        if (response.op === "probeGh") view = { ...view, probe: response.data };
        return true;
      })
      .catch((error: unknown) => {
        const failure = hostErrorSchema.safeParse(error);
        if (!failure.success) {
          view = { ...view, problem: transportProblem(error) };
          return false;
        }
        accept(failure.data.status);
        const { kind, message } = failure.data;
        const explained = kind === "signedOut" || kind === "notConnected";
        view = { ...view, problem: explained ? null : message };
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

  return {
    read: () => view,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh: () => runOnce({ op: "status" }),
    probeGh: () => runOnce({ op: "probeGh" }),
    connectGh: (login: string) => runOnce({ op: "connectGh", login }),
    verify: () => runOnce({ op: "verify" }),
    disconnect: () => runOnce({ op: "disconnect" }),
    startDevice: () => runOnce({ op: "deviceStart" }),
    cancelDevice() {
      const prompt = view.status?.deviceCode;
      return prompt
        ? runOnce({ op: "deviceCancel", session: prompt.session })
        : Promise.resolve(true);
    },
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
