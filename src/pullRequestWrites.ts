import type { Anchor, SentWrite } from "./domain/drafts";
import type { Carried, Wrote } from "./domain/host";
import type { PullRequest } from "./domain/pullRequest";
import type { Echo, PullWrite } from "./domain/pullRequestWrites";
import type { GitHubRepository, Oid } from "./domain/repository";
import type { createDrafts, DraftsOf } from "./drafts";
import type { HostClient } from "./host";
import { signIn, stamp } from "./pullRequests";
import type { Read } from "./pullRequests";

/** One pull request, as the detail reads name it. */
export type PullOf = { repository: GitHubRepository; number: number };

/** A saved draft a write sends. The host takes it out of the drafts before
 * the write leaves, and deletes it once GitHub has its words. */
type DraftRef = { anchor: Anchor; head: Oid };

/** One click, from sending to what GitHub or a read says of it. */
type AttemptState =
  | { kind: "sending" }
  /** GitHub did it. Its words show from `write` until a read asked after
   * `answeredAt` has them. */
  | { kind: "done"; echo: Echo; answeredAt: number }
  | { kind: "refused"; message: string }
  | { kind: "notSent"; message: string }
  /** A read shows GitHub didn't do a write it can do twice without harm,
   * such as resolve or merge, so sending it again is safe. */
  | { kind: "notLanded"; message: string }
  /**
   * It may have posted. While the host keeps it, nothing else is sent for
   * the pull request, and each read of it looks again. The choices are Open
   * on GitHub, `keep` (Keep as draft) and `sendAnyway`, which may post it
   * twice. `kept` is false when the host lost track of it too, and then
   * there is nothing to keep or send again.
   */
  | { kind: "unknown"; message: string; kept: boolean };

export type Attempt = {
  id: string;
  write: PullWrite;
  /** The login it was sent as. */
  viewer: string;
  state: AttemptState;
};

type Drafts = Pick<
  ReturnType<typeof createDrafts>,
  "read" | "load" | "adopt" | "carried" | "keep" | "subscribe" | "hold"
>;

const none: readonly Attempt[] = [];
const mayHavePosted =
  "L1 Git sent this to GitHub and got no answer, so it may have posted. L1 Git looks again each time it reads this pull request.";

const keyOf = ({ repository, number }: PullOf) =>
  `${repository.owner}/${repository.repo}#${number}`.toLowerCase();

const holds = ({ state }: Attempt) =>
  state.kind === "sending" || (state.kind === "unknown" && state.kept);

/**
 * Every write to GitHub goes through here, one lane per pull request. The
 * host holds the lane: it keeps each write in drafts.json from before it
 * leaves until its outcome is known, so another window, a restart or signing
 * in again sees the same write. Nothing here sends a write again unless the
 * user picks Send anyway.
 */
export function createPullRequestWrites(deps: {
  host: Pick<HostClient, "read" | "subscribe" | "write" | "sendAgain" | "ask">;
  details: {
    read: () => (pull: PullOf) => Read<PullRequest>;
    subscribe: (listener: () => void) => () => void;
  };
  /** Reads the pull request again, asked after now even while a read of it
   * runs: the read queue's `addFirst` with `again`. */
  reread: (pull: PullOf) => void;
  drafts: Drafts;
  /** `beginDraftTask`, so an update waits for a write's answer. */
  task: () => (() => void) | null;
}) {
  const listeners = new Set<() => void>();
  const fresh = () => ({
    name: signIn(deps.host.read().status),
    /** This window's attempts, by pull request. */
    local: new Map<string, readonly Attempt[]>(),
    pulls: new Map<string, PullOf>(),
    shown: new Map<
      string,
      {
        local: readonly Attempt[];
        sent: readonly SentWrite[];
        all: readonly Attempt[];
      }
    >(),
    /** When each pull request was last checked, as a read's `askedAt`. */
    checked: new Map<string, number>(),
    checking: new Set<string>(),
  });
  let held = fresh();

  /** Derived on every access, so another sign-in never sees these writes. */
  function current() {
    if (held.name !== signIn(deps.host.read().status)) held = fresh();
    return held;
  }

  const tell = () => listeners.forEach((listener) => listener());
  const draftsOf = (pull: PullOf, viewer: string): DraftsOf => ({
    login: viewer,
    ...pull,
  });
  const viewer = () => {
    const github = deps.host.read().status?.github;
    return github?.kind === "connected" ? github.login : null;
  };

  function put(pull: PullOf, attempts: readonly Attempt[]) {
    const { local, pulls } = current();
    local.set(keyOf(pull), attempts);
    pulls.set(keyOf(pull), pull);
    tell();
  }

  function change(pull: PullOf, id: string, state: AttemptState | null) {
    const attempts = current().local.get(keyOf(pull)) ?? none;
    put(
      pull,
      state === null
        ? attempts.filter((attempt) => attempt.id !== id)
        : attempts.map((attempt) =>
            attempt.id === id ? { ...attempt, state } : attempt,
          ),
    );
  }

  /** This window's attempts, then each write the host keeps that this
   * window isn't sending. */
  function attempts(pull: PullOf): readonly Attempt[] {
    const { shown, pulls } = current();
    const key = keyOf(pull);
    pulls.set(key, pull);
    const login = viewer();
    const local = current().local.get(key) ?? none;
    const sent = login ? deps.drafts.read(draftsOf(pull, login)).sent : [];
    const last = shown.get(key);
    if (last?.local === local && last.sent === sent) return last.all;
    const kept = new Set(sent.map(({ attempt }) => attempt));
    const tracked = new Set(
      local.filter(({ state }) => state.kind !== "unknown").map(({ id }) => id),
    );
    const all: Attempt[] = [
      ...local.filter(
        ({ id, state }) => !(state.kind === "unknown" && kept.has(id)),
      ),
      ...sent
        .filter(({ attempt }) => !tracked.has(attempt))
        .map(
          ({ attempt, write, sending }): Attempt => ({
            id: attempt,
            write,
            viewer: login ?? "",
            state: sending
              ? { kind: "sending" }
              : { kind: "unknown", message: mayHavePosted, kept: true },
          }),
        ),
    ];
    const answer = all.length === 0 ? none : all;
    shown.set(key, { local, sent, all: answer });
    return answer;
  }

  function heard(
    pull: PullOf,
    attempt: Attempt,
    wrote: Wrote,
    name: string | null,
    release: () => void,
  ) {
    const { written, drafts } = wrote;
    const of = draftsOf(pull, attempt.viewer);
    release();
    if (drafts) deps.drafts.adopt(of, drafts);
    else void deps.drafts.load(of);
    if (current().name !== name) return;
    switch (written.kind) {
      case "done":
        change(pull, attempt.id, {
          kind: "done",
          echo: written.echo,
          answeredAt: stamp(),
        });
        break;
      case "refused":
      case "notSent":
        change(pull, attempt.id, written);
        break;
      case "unknown":
        // While the host keeps it, its record stands for it, and the reread
        // below looks for it.
        change(
          pull,
          attempt.id,
          drafts?.sent.some((sent) => sent.attempt === attempt.id)
            ? null
            : { kind: "unknown", message: written.message, kept: false },
        );
        break;
    }
    if (written.kind !== "notSent") deps.reread(pull);
  }

  /** Asks the host what a read shows of each write it keeps for `pull`. */
  function check(pull: PullOf) {
    const { checking, checked, name } = current();
    const key = keyOf(pull);
    const login = viewer();
    if (!login || checking.has(key)) return;
    checking.add(key);
    checked.set(key, stamp());
    void deps.host
      .ask({ op: "check", asLogin: login, ...pull })
      .then((answer) => {
        if (current().name !== name) return;
        checking.delete(key);
        if (!answer.ok) return tell();
        const { settled, drafts } = answer.reply.data;
        deps.drafts.adopt(draftsOf(pull, login), drafts);
        const settles = new Set(settled.map(({ attempt }) => attempt));
        put(pull, [
          ...(current().local.get(key) ?? none).filter(
            ({ id }) => !settles.has(id),
          ),
          ...settled.map(
            ({ attempt, write, seen }): Attempt => ({
              id: attempt,
              write,
              viewer: login,
              state:
                seen.kind === "landed"
                  ? { kind: "done", echo: seen.echo, answeredAt: stamp() }
                  : seen,
            }),
          ),
        ]);
        if (settled.some(({ seen }) => seen.kind === "landed"))
          deps.reread(pull);
      });
  }

  /** A read asked after a done write's answer shows it, so its words go;
   * and each fresh read of a pull request with a write that may have posted
   * looks again, also when the host's record of it arrives after the read. */
  function look() {
    const read = deps.details.read();
    for (const [key, pull] of current().pulls) {
      const { askedAt, value } = read(pull);
      if (askedAt === null || value === null) continue;
      const local = current().local.get(key) ?? none;
      const shown = local.filter(
        ({ state }) => state.kind === "done" && state.answeredAt < askedAt,
      );
      if (shown.length > 0)
        put(
          pull,
          local.filter((attempt) => !shown.includes(attempt)),
        );
      const waits = attempts(pull).some(
        ({ state }) => state.kind === "unknown" && state.kept,
      );
      if (waits && askedAt > (current().checked.get(key) ?? 0)) check(pull);
    }
  }
  deps.details.subscribe(look);
  deps.drafts.subscribe(look);

  function start(
    pull: PullOf,
    write: PullWrite,
    send: (id: string, login: string) => Promise<Wrote>,
    id: string,
    places: readonly DraftRef[] = [],
  ): "started" | "signedOut" | "restarting" {
    const login = viewer();
    if (!login) return "signedOut";
    const finish = deps.task();
    if (!finish) return "restarting";
    const release = deps.drafts.hold(draftsOf(pull, login), places);
    const { name } = current();
    const attempt: Attempt = {
      id,
      write,
      viewer: login,
      state: { kind: "sending" },
    };
    put(pull, [
      ...(current().local.get(keyOf(pull)) ?? none).filter(
        (each) => each.id !== id,
      ),
      attempt,
    ]);
    void send(id, login).then((wrote) => {
      finish();
      heard(pull, attempt, wrote, name, release);
    });
    return "started";
  }

  return {
    /** "busy" sends nothing: a write of this pull request is sending or may
     * have posted. "unsaved" sends nothing: a draft it carries has words the
     * host hasn't saved, so `flush` the drafts first. */
    send(
      pull: PullOf,
      write: PullWrite,
      drafts: readonly DraftRef[] = [],
    ): "started" | "busy" | "unsaved" | "signedOut" | "restarting" {
      const login = viewer();
      if (!login) return "signedOut";
      if (attempts(pull).some(holds)) return "busy";
      const of = draftsOf(pull, login);
      const carried = drafts.map(({ anchor, head }) =>
        deps.drafts.carried(of, anchor, head),
      );
      if (carried.includes(null)) return "unsaved";
      return start(
        pull,
        write,
        (attempt, asLogin) =>
          deps.host.write({
            asLogin,
            ...pull,
            attempt,
            write,
            drafts: carried as Carried[],
          }),
        crypto.randomUUID(),
        drafts,
      );
    },
    /** Send anyway: sends a write that may have posted once more, unless the
     * host's read first shows it landed. It may post twice. */
    sendAnyway(
      pull: PullOf,
      id: string,
    ): "started" | "signedOut" | "restarting" | "gone" {
      const found = attempts(pull).find(
        (attempt) => attempt.id === id && attempt.state.kind === "unknown",
      );
      if (!found || found.state.kind !== "unknown" || !found.state.kept)
        return "gone";
      return start(
        pull,
        found.write,
        (attempt, asLogin) =>
          deps.host.sendAgain({ asLogin, ...pull, attempt }),
        id,
      );
    },
    /** Keep as draft: the words come back to typing, marked as may have
     * posted, and the pull request is free to write again. */
    async keep(pull: PullOf, id: string): Promise<boolean> {
      const login = viewer();
      if (!login) return false;
      const kept = await deps.drafts.keep(draftsOf(pull, login), id);
      if (kept) change(pull, id, null);
      return kept;
    },
    /** The same array until one of them changes. Oldest first. */
    attempts,
    busy: (pull: PullOf) => attempts(pull).some(holds),
    /** Clears a notice. One still sending, done or kept as unknown stays. */
    dismiss(pull: PullOf, id: string) {
      const local = current().local.get(keyOf(pull)) ?? none;
      const kept = local.filter(
        (attempt) =>
          attempt.id !== id || holds(attempt) || attempt.state.kind === "done",
      );
      if (kept.length !== local.length) put(pull, kept);
    },
    /** Also tells of a sign-in change, which shows another sign-in's lanes,
     * and of the host's kept writes changing. */
    subscribe(listener: () => void) {
      const heard = () => listener();
      listeners.add(heard);
      const stopHost = deps.host.subscribe(heard);
      const stopDrafts = deps.drafts.subscribe(heard);
      return () => {
        listeners.delete(heard);
        stopHost();
        stopDrafts();
      };
    },
  };
}
