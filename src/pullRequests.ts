import type { HostProblem, HostStatus } from "./domain/host";
import type { PullRequestList } from "./domain/pullRequest";
import type { GitHubRepository } from "./domain/repository";
import type { HostClient } from "./host";

type HostReader = Pick<HostClient, "read" | "subscribe" | "ask">;
type Answered<T> =
  | { ok: true; reply: { data: T } }
  | { ok: false; problem: HostProblem };

/** The last value stays while a read runs and after one fails. */
export type Read<T> = {
  value: T | null;
  /** When `value` was answered, in milliseconds. */
  at: number | null;
  reading: boolean;
  problem: HostProblem | null;
};
const unread: Read<never> = {
  value: null,
  at: null,
  reading: false,
  problem: null,
};

/**
 * Names one sign-in. Two accounts never share a name, so a read that starts and
 * ends under one name was answered for that account. Only the same account
 * signing in twice within a second keeps its name.
 */
export function signIn(status: HostStatus | null): string | null {
  return status?.github.kind === "connected"
    ? `${status.github.login} ${status.github.connectedAt}`
    : null;
}

function createReads<Request, T>(
  host: HostReader,
  keyOf: (request: Request) => string,
  ask: (request: Request) => Promise<Answered<T>>,
) {
  const listeners = new Set<() => void>();
  const hold = (
    name: string | null,
    running = new Map<string, Promise<void>>(),
    reads: ReadonlyMap<string, Read<T>> = new Map(),
  ) => ({
    name,
    running,
    reads,
    look: (request: Request): Read<T> => reads.get(keyOf(request)) ?? unread,
  });
  let held = hold(null);

  /** Derived on every access, so nothing read under another sign-in can show. */
  function current() {
    const name = signIn(host.read().status);
    if (held.name !== name) held = hold(name);
    return held;
  }

  function put(key: string, read: Read<T>) {
    const { name, running, reads } = held;
    held = hold(name, running, new Map(reads).set(key, read));
    listeners.forEach((listener) => listener());
  }

  function refresh(request: Request): Promise<void> {
    const { name, running, look } = current();
    if (name === null) return Promise.resolve();
    const key = keyOf(request);
    const already = running.get(key);
    if (already) return already;
    const last = look(request);
    const read = ask(request).then((answer) => {
      running.delete(key);
      if (current().running !== running) return;
      put(
        key,
        answer.ok
          ? {
              value: answer.reply.data,
              at: Date.now(),
              reading: false,
              problem: null,
            }
          : { ...last, problem: answer.problem },
      );
    });
    running.set(key, read);
    put(key, { ...last, reading: true });
    return read;
  }

  return {
    /** Changes identity whenever any answer it gives does. */
    read: () => current().look,
    refresh,
    subscribe(listener: () => void) {
      const heard = () => listener();
      listeners.add(heard);
      const stop = host.subscribe(heard);
      return () => {
        listeners.delete(heard);
        stop();
      };
    },
  };
}

/** GitHub's names ignore case. */
const named = ({ owner, repo }: GitHubRepository) =>
  `${owner}/${repo}`.toLowerCase();

export function createPullRequests(host: HostReader) {
  return {
    lists: createReads(
      host,
      (of: { repository: GitHubRepository; list: PullRequestList }) =>
        `${named(of.repository)} ${of.list}`,
      (of) => host.ask({ op: "pullRequests", ...of }),
    ),
    details: createReads(
      host,
      (of: { repository: GitHubRepository; number: number }) =>
        `${named(of.repository)} ${of.number}`,
      (of) => host.ask({ op: "pullRequest", ...of }),
    ),
  };
}
