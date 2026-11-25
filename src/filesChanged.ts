import { countsNotice, inTreeOrder, rangeOf } from "./domain/filesChanged";
import type { Range, Stop } from "./domain/filesChanged";
import type { PullRequest } from "./domain/pullRequest";
import type { ListedRepository } from "./domain/pullRequestList";
import type { CommitsFetch, RangeFile } from "./domain/range";
import { patchText } from "./domain/fileSides";
import { problemFrom } from "./domain/repository";
import type {
  FilePatch,
  GitHubRepository,
  Oid,
  PatchContext,
  Problem,
  RepositoryRoot,
} from "./domain/repository";
import type * as repositories from "./repositories";

export type PatchRead =
  | { kind: "reading" }
  | { kind: "ready"; patch: FilePatch }
  | { kind: "failed"; problem: Problem };

type RangeRead =
  | { kind: "reading" }
  | { kind: "fetching" }
  | { kind: "stopped"; stop: Stop }
  | {
      kind: "ready";
      mergeBase: Oid;
      files: readonly RangeFile[];
      contentMissing: boolean;
      /** How this is not what GitHub counts, or null when it is. */
      counts: string | null;
    };

/** What the Files changed tab holds, whichever way it shows it. */
export type FilesChanged = {
  /** The pull request, as one sign-in reads it. */
  of: string;
  range: Range;
  /** The newest read whose head is the range's. */
  pull: PullRequest;
  read: RangeRead;
  /** The current file, among the files that were read. */
  at: number;
  /** Where in the current file to begin. */
  enter: "start" | "end";
  /** A file that is not here was not asked for yet. */
  patches: ReadonlyMap<RangeFile, PatchRead>;
};

type Deps = Pick<
  typeof repositories,
  "rangeFiles" | "rangePatches" | "filePatch" | "fetchCommits"
>;

/** How long to wait for a fresher read before showing the one there is. */
const MOST_WAIT = 1_000;

/** GitHub gives up on the threads of some reads, and they are still there. */
const withThreads = (pull: PullRequest, last: PullRequest): PullRequest =>
  pull.threads === null && pull.head.oid === last.head.oid
    ? { ...pull, threads: last.threads }
    : pull;

export function createFilesChanged(deps: Deps) {
  const listeners = new Set<() => void>();
  let held: FilesChanged | null = null;
  let newest: PullRequest | null = null;
  /** The path to come back to when another range is read. */
  let path: string | null = null;
  let wait: ReturnType<typeof setTimeout> | null = null;
  /** Another object for each range read, so that no late answer is of another. */
  let turn: object = {};
  const fetches = new Map<string, Promise<CommitsFetch>>();

  function put(next: FilesChanged | null) {
    held = next;
    listeners.forEach((listener) => listener());
  }

  /** A fetch that an earlier look at the tab began is the same one. */
  function fetchCommits(
    root: RepositoryRoot,
    github: GitHubRepository,
    oids: [Oid] | [Oid, Oid],
  ) {
    const key = [root, ...oids].join(" ");
    const running = fetches.get(key);
    if (running) return running;
    const fetch = deps
      .fetchCommits(root, github, oids)
      .catch((error: unknown): CommitsFetch => {
        const { message } = problemFrom(error);
        return { kind: "failed", failure: "other", message };
      })
      .finally(() => fetches.delete(key));
    fetches.set(key, fetch);
    return fetch;
  }

  async function load(
    { repository: { root, github }, baseOid, head }: Range,
    pinned: PullRequest,
    isCurrent: () => boolean,
    set: (change: Partial<FilesChanged>) => void,
  ) {
    const stopped = (stop: Stop) => set({ read: { kind: "stopped", stop } });
    const look = () => deps.rangeFiles(root, baseOid, head);
    let found = await look();
    if (found.kind === "missing" && isCurrent()) {
      set({ read: { kind: "fetching" } });
      const [first = head, second] = found.oids;
      const got = await fetchCommits(
        root,
        github,
        second === undefined ? [first] : [first, second],
      );
      if (got.kind !== "done") return stopped(got);
      if (!isCurrent()) return;
      found = await look();
    }
    if (found.kind === "missing") return stopped({ kind: "stillMissing" });
    if (found.kind !== "ready") return stopped(found);
    const counts = countsNotice(found, pinned);
    if (counts !== null && found.shallow)
      return stopped({ kind: "unrelated", shallow: true });
    const { files: listed, mergeBase, contentMissing } = found;
    const files = inTreeOrder(listed);
    const at = Math.max(
      0,
      files.findIndex((file) => file.path === path),
    );
    const read = {
      kind: "ready",
      mergeBase,
      files,
      contentMissing,
      counts,
    } as const;
    if (contentMissing || files.length === 0) return set({ read, at });
    set({
      read,
      at,
      patches: new Map(files.map((file) => [file, { kind: "reading" }])),
    });
    if (!isCurrent()) return;
    // A file without an answer here is read by itself.
    const answers = await deps
      .rangePatches(root, mergeBase, head)
      .catch(() => []);
    const patches = new Map<RangeFile, PatchRead>();
    for (const [place, file] of listed.entries()) {
      const answer = answers[place];
      if (answer?.path === file.path && answer.patch !== null)
        patches.set(file, { kind: "ready", patch: answer.patch });
    }
    set({ patches });
    if (isCurrent()) readCurrent();
  }

  function begin(next: FilesChanged) {
    const mine = {};
    turn = mine;
    const isCurrent = () => turn === mine;
    const set = (change: Partial<FilesChanged>) => {
      if (isCurrent() && held) put({ ...held, ...change });
    };
    put(next);
    load(next.range, next.pull, isCurrent, set).catch((error: unknown) => {
      const stop: Stop = { kind: "unreadable", problem: problemFrom(error) };
      set({ read: { kind: "stopped", stop } });
    });
  }

  function stopWaiting() {
    if (wait !== null) clearTimeout(wait);
    wait = null;
  }

  function showNewest() {
    if (!held || !newest) return;
    stopWaiting();
    const range = rangeOf(held.range.repository, newest);
    const pull = withThreads(newest, held.pull);
    begin({ of: held.of, range, pull, ...unread });
  }

  const unread = {
    read: { kind: "reading" },
    at: 0,
    enter: "start",
    patches: new Map(),
  } as const;

  function patchOf(file: RangeFile, context: PatchContext) {
    if (held?.read.kind !== "ready")
      return Promise.reject(new Error("The range was not read."));
    const { range, read } = held;
    return deps.filePatch(
      range.repository.root,
      {
        base: { kind: "commit", oid: read.mergeBase },
        target: { kind: "commit", oid: range.head },
      },
      file.path,
      context,
      file.from ?? file.path,
    );
  }

  function readPatch(file: RangeFile) {
    const mine = turn;
    const set = (patch: PatchRead) => {
      if (turn === mine && held)
        put({ ...held, patches: new Map(held.patches).set(file, patch) });
    };
    set({ kind: "reading" });
    patchOf(file, "hunks").then(
      (patch) => set({ kind: "ready", patch }),
      (error: unknown) => set({ kind: "failed", problem: problemFrom(error) }),
    );
  }

  function current(): RangeFile | null {
    return held?.read.kind === "ready"
      ? (held.read.files[held.at] ?? null)
      : null;
  }

  function readCurrent() {
    const file = current();
    if (held?.read.kind !== "ready" || held.read.contentMissing || !file)
      return;
    if (!held.patches.has(file)) readPatch(file);
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    read: () => held,
    /**
     * Begins once for `of`, and after that learns only what may change.
     * `isComing` while a fresher read is on its way, which is waited for.
     */
    see(
      of: string,
      repository: ListedRepository,
      pull: PullRequest,
      isComing: boolean,
    ) {
      const isNew = newest !== pull;
      newest = pull;
      if (held?.of !== of) {
        stopWaiting();
        path = null;
        turn = {};
        put({ of, range: rangeOf(repository, pull), pull, ...unread });
        if (isComing) wait = setTimeout(showNewest, MOST_WAIT);
        else showNewest();
      } else if (wait !== null) {
        if (!isComing) showNewest();
      } else if (isNew && pull.head.oid === held.range.head)
        put({ ...held, pull: withThreads(pull, held.pull) });
    },
    showNewest,
    retry() {
      const file = current();
      if (held?.read.kind === "stopped") begin({ ...held, ...unread });
      else if (file) readPatch(file);
    },
    go(at: number, enter: FilesChanged["enter"] = "start") {
      if (held?.read.kind !== "ready") return;
      const file = held.read.files[at];
      if (!file || at === held.at) return;
      path = file.path;
      put({ ...held, at, enter });
      readCurrent();
    },
    /** The current file with every line of context. */
    async whole(file: RangeFile) {
      return patchText(await patchOf(file, "whole"));
    },
    close() {
      stopWaiting();
      turn = {};
      newest = null;
      if (held) put(null);
    },
  };
}
