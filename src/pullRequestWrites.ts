import type { Anchor } from "./domain/drafts";
import type { PullRequest } from "./domain/pullRequest";
import { landed } from "./domain/pullRequestWrites";
import type { PullWrite, Written } from "./domain/pullRequestWrites";
import type { GitHubRepository, Oid } from "./domain/repository";
import type { DraftsOf } from "./drafts";
import type { HostClient } from "./host";
import { signIn, stamp } from "./pullRequests";
import type { Read } from "./pullRequests";

/** One pull request, as the detail reads name it. */
export type PullOf = { repository: GitHubRepository; number: number };

/** A draft a write sends. It is deleted once GitHub has its words. */
type SentDraft = { anchor: Anchor; head: Oid };

type Echo = Extract<Written, { kind: "done" }>["echo"];

/** One click, from sending to what a read shows. */
type AttemptState =
  | { kind: "sending" }
  /** GitHub did it. Its words show from `write` until a read has them. */
  | { kind: "done"; echo: Echo; answeredAt: number }
  | { kind: "refused"; message: string }
  | { kind: "notSent"; message: string }
  /** No answer said. Nothing more is sent for this pull request until a
   * read asked after `answeredAt` settles it. */
  | { kind: "unknown"; message: string; answeredAt: number }
  /** A read asked after the answer shows whether it landed. */
  | { kind: "settled"; landed: boolean; after: "done" | "unknown" };

export type Attempt = {
  id: number;
  write: PullWrite;
  drafts: readonly SentDraft[];
  /** The login it was sent as. */
  viewer: string;
  /** When it was sent, by this computer's clock. */
  since: number;
  state: AttemptState;
};

type Lane = { pull: PullOf; attempts: readonly Attempt[] };

const none: readonly Attempt[] = [];
const lost =
  "L1 Git lost track of this write, so GitHub may or may not have done it. L1 Git reads the pull request again to find out.";

const keyOf = ({ repository, number }: PullOf) =>
  `${repository.owner}/${repository.repo}#${number}`.toLowerCase();

const holds = ({ state }: Attempt) =>
  state.kind === "sending" || state.kind === "unknown";

function answered(written: Written, answeredAt: number): AttemptState {
  switch (written.kind) {
    case "done":
      return { kind: "done", echo: written.echo, answeredAt };
    case "unknown":
      return { kind: "unknown", message: written.message, answeredAt };
    case "refused":
    case "notSent":
      return { kind: written.kind, message: written.message };
  }
}

/** What a fresh read of the pull request says of one attempt, if anything. */
function settled(attempt: Attempt, read: Read<PullRequest>) {
  const { state } = attempt;
  if (state.kind !== "done" && state.kind !== "unknown") return null;
  if (read.value === null || (read.askedAt ?? 0) <= state.answeredAt)
    return null;
  const shown = landed(
    attempt.write,
    read.value,
    attempt.since,
    attempt.viewer,
  );
  // GitHub said it did it, so only a read that shows otherwise waits.
  if (state.kind === "done")
    return shown === false ? null : { landed: true, after: state.kind };
  return shown === null ? null : { landed: shown, after: state.kind };
}

/**
 * Every write to GitHub goes through here, one lane per pull request: while
 * one of a pull request's writes is sending or unknown, the next is refused
 * as busy and sends nothing. Nothing here sends a write again.
 */
export function createPullRequestWrites(deps: {
  host: Pick<HostClient, "read" | "subscribe" | "write">;
  details: {
    read: () => (pull: PullOf) => Read<PullRequest>;
    subscribe: (listener: () => void) => () => void;
  };
  /** Reads the pull request again, asked after now even while a read of it
   * runs: the read queue's `addFirst` with `again`. */
  reread: (pull: PullOf) => void;
  drafts: {
    remove: (of: DraftsOf, anchor: Anchor, head: Oid) => Promise<boolean>;
  };
  /** `beginDraftTask`, so an update waits for a write's answer. */
  task: () => (() => void) | null;
}) {
  const listeners = new Set<() => void>();
  let held = { name: null as string | null, lanes: new Map<string, Lane>() };
  let made = 0;

  /** Derived on every access, so another sign-in never sees these writes. */
  function current() {
    const name = signIn(deps.host.read().status);
    if (held.name !== name) held = { name, lanes: new Map() };
    return held;
  }

  function change(key: string, id: number, state: AttemptState) {
    const lane = current().lanes.get(key);
    if (!lane) return;
    const attempts = lane.attempts.map((attempt) =>
      attempt.id === id ? { ...attempt, state } : attempt,
    );
    current().lanes.set(key, { ...lane, attempts });
    listeners.forEach((listener) => listener());
  }

  function forget(attempt: Attempt, pull: PullOf) {
    for (const { anchor, head } of attempt.drafts)
      void deps.drafts.remove({ login: attempt.viewer, ...pull }, anchor, head);
  }

  function settle() {
    const look = deps.details.read();
    for (const [key, { pull, attempts }] of current().lanes)
      for (const attempt of attempts) {
        const shown = settled(attempt, look(pull));
        if (shown === null) continue;
        if (shown.landed && attempt.state.kind === "unknown")
          forget(attempt, pull);
        change(key, attempt.id, { kind: "settled", ...shown });
      }
  }
  deps.details.subscribe(settle);

  return {
    /** "busy" sends nothing: another write of this pull request is sending
     * or has an outcome no read has settled yet. */
    send(
      pull: PullOf,
      write: PullWrite,
      drafts: readonly SentDraft[] = [],
    ): "started" | "busy" | "signedOut" | "restarting" {
      const { status } = deps.host.read();
      const { lanes } = current();
      if (status?.github.kind !== "connected") return "signedOut";
      const key = keyOf(pull);
      const lane = lanes.get(key) ?? { pull, attempts: none };
      if (lane.attempts.some(holds)) return "busy";
      const finish = deps.task();
      if (!finish) return "restarting";
      const attempt: Attempt = {
        id: (made += 1),
        write,
        drafts,
        viewer: status.github.login,
        since: Date.now(),
        state: { kind: "sending" },
      };
      lanes.set(key, { pull, attempts: [...lane.attempts, attempt] });
      listeners.forEach((listener) => listener());
      const hear = (written: Written) => {
        finish();
        const at = stamp();
        if (written.kind === "done") forget(attempt, pull);
        if (current().lanes !== lanes) return;
        change(key, attempt.id, answered(written, at));
        if (written.kind !== "notSent") deps.reread(pull);
      };
      deps.host
        .write({ asLogin: attempt.viewer, write })
        .then(hear, () => hear({ kind: "unknown", message: lost }));
      return "started";
    },
    /** The same array until one of them changes. Oldest first. */
    attempts: (pull: PullOf): readonly Attempt[] =>
      current().lanes.get(keyOf(pull))?.attempts ?? none,
    busy: (pull: PullOf) =>
      (current().lanes.get(keyOf(pull))?.attempts ?? none).some(holds),
    /** Clears a notice. One still sending, done or unknown stays. */
    dismiss(pull: PullOf, id: number) {
      const key = keyOf(pull);
      const lane = current().lanes.get(key);
      const attempts = lane?.attempts.filter(
        (attempt) =>
          attempt.id !== id || holds(attempt) || attempt.state.kind === "done",
      );
      if (!lane || !attempts || attempts.length === lane.attempts.length)
        return;
      current().lanes.set(key, { ...lane, attempts });
      listeners.forEach((listener) => listener());
    },
    /** Also tells of a sign-in change, which shows another sign-in's lanes. */
    subscribe(listener: () => void) {
      const heard = () => listener();
      listeners.add(heard);
      const stop = deps.host.subscribe(heard);
      return () => {
        listeners.delete(heard);
        stop();
      };
    },
  };
}
