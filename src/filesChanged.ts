import { countsNotice, inTreeOrder, rangeOf } from "./domain/filesChanged";
import type { Range, Stop } from "./domain/filesChanged";
import type { PullRequest } from "./domain/pullRequest";
import type { ListedRepository } from "./domain/pullRequestList";
import type { CommitsFetch, RangeFile, SinceReady } from "./domain/range";
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
import { reviewPointOf, sinceGroups } from "./domain/sinceReview";
import type { ReviewPoint, SinceGroups, SinceStop } from "./domain/sinceReview";
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
    };

type SinceRead =
  | { kind: "reading" }
  | { kind: "fetching" }
  | { kind: "stopped"; stop: SinceStop }
  | SinceReady;

/** What changed since your last review, beside what the pull request changes. */
export type Since = {
  /** Pinned with the range, so a review sent meanwhile changes nothing shown. */
  point: ReviewPoint;
  read: SinceRead;
  /** A stop shows all changes. */
  showing: "since" | "all";
  /** The files that only the base's changes moved, which the since view leaves out until asked. */
  rebased: "folded" | "shown";
};

/** What the Files changed tab holds, whichever way it shows it. */
export type FilesChanged = {
  /** The pull request, as one sign-in reads it. */
  of: string;
  range: Range;
  /** The newest read whose head is the range's. */
  pull: PullRequest;
  /** The newest whose base branch is, too: its counts are of the range. */
  counted: PullRequest;
  read: RangeRead;
  /** Null without a review to compare with. */
  since: Since | null;
  /** The current file, among the files shown. */
  at: number;
  /** Where in the current file to begin. */
  enter: "start" | "end";
  /**
   * Null until all were asked for. A file that is not here is to be read by
   * itself. The since read's files are other objects than the range's, so
   * both are here.
   */
  patches: ReadonlyMap<RangeFile, PatchRead> | null;
};

/** The since view's files, derived from the two reads. */
export type SinceShown = {
  groups: SinceGroups;
  /** For each file the author changed since your review, the pull request's file at its path, or null for one it no longer changes. */
  nowOf: ReadonlyMap<RangeFile, RangeFile | null>;
  /** What the author changed, in the order of the tree. */
  again: readonly RangeFile[];
  /** The same, followed by the files that only the base's changes moved. */
  withRebased: readonly RangeFile[];
};

const derived = new WeakMap<SinceReady, SinceShown>();

/** Null until both reads are ready. */
export function sinceShown({
  read,
  since,
}: Pick<FilesChanged, "read" | "since">): SinceShown | null {
  if (read.kind !== "ready" || since?.read.kind !== "ready") return null;
  const known = derived.get(since.read);
  if (known) return known;
  const groups = sinceGroups(read.files, since.read);
  const again = inTreeOrder(groups.again.map(({ since: file }) => file));
  const made = {
    groups,
    nowOf: new Map(groups.again.map(({ since: file, now }) => [file, now])),
    again,
    withRebased: [
      ...again,
      ...inTreeOrder(groups.rebased.map(({ now }) => now)),
    ],
  };
  derived.set(since.read, made);
  return made;
}

/**
 * Whether Git could not read the contents of a file shown, or of every file
 * shown when none is named. A file of what changed since your review needs
 * the since read's contents, and the range's too, without which no patch is
 * read.
 */
export function isContentMissing(
  { read, since }: Pick<FilesChanged, "read" | "since">,
  file?: RangeFile,
): boolean {
  if (read.kind !== "ready") return false;
  if (read.contentMissing) return true;
  return (
    since?.showing === "since" &&
    since.read.kind === "ready" &&
    since.read.contentMissing &&
    (file === undefined || since.read.files.includes(file))
  );
}

/** Whether the tab shows what changed since your review. */
export const isSinceShown = ({ since }: Pick<FilesChanged, "since">) =>
  since?.showing === "since";

const none: readonly RangeFile[] = [];

/** The files the tab shows, which `at` is among. */
export function shownFiles(
  held: Pick<FilesChanged, "read" | "since">,
): readonly RangeFile[] {
  const { read, since } = held;
  if (read.kind !== "ready") return none;
  if (since === null || since.showing === "all") return read.files;
  const shown = sinceShown(held);
  if (shown === null) return none;
  return since.rebased === "shown" ? shown.withRebased : shown.again;
}

/** "3 new" once what changed since your review is read, "new" before, and null without a review to compare with. */
export function newLabel(
  held: FilesChanged | null,
  pull: PullRequest,
): string | null {
  const since = held === null ? sinceFor(pull, null) : held.since;
  if (since === null || since.point.oid === null) return null;
  if (since.read.kind === "stopped") return null;
  const shown = held && sinceShown(held);
  return shown ? `${shown.groups.again.length.toLocaleString()} new` : "new";
}

function sinceFor(pull: PullRequest, before: Since | null): Since | null {
  const point = reviewPointOf(pull);
  if (point === null) return null;
  if (point.oid === null)
    return {
      point,
      read: { kind: "stopped", stop: { kind: "gone" } },
      showing: "all",
      rebased: "folded",
    };
  const isChosen = before !== null && before.read.kind !== "stopped";
  return {
    point,
    read: { kind: "reading" },
    showing: isChosen ? before.showing : "since",
    rebased: before?.rebased ?? "folded",
  };
}

type Deps = Pick<
  typeof repositories,
  "rangeFiles" | "rangePatches" | "filePatch" | "fetchCommits" | "sinceReview"
>;

/** How long to wait for a fresher read before showing the one there is. */
const MOST_WAIT = 1_000;

/** GitHub gives up on the threads of some reads, and they are still there. */
const withThreads = (pull: PullRequest, last: PullRequest): PullRequest =>
  pull.threads === null && pull.head.oid === last.head.oid
    ? { ...pull, threads: last.threads }
    : pull;

/** Each answer of a patch read to its file, by place. */
function patchesOf(
  files: readonly RangeFile[],
  answers: Awaited<ReturnType<Deps["rangePatches"]>>,
  into: Map<RangeFile, PatchRead>,
) {
  for (const [place, file] of files.entries()) {
    const answer = answers[place];
    if (answer?.path === file.path && answer.patch !== null)
      into.set(file, { kind: "ready", patch: answer.patch });
  }
}

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

  /** Where the path to come back to is among the files shown, or else the first. */
  const atPath = (next: FilesChanged) =>
    Math.max(
      0,
      shownFiles(next).findIndex((file) => file.path === path),
    );

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

  /** Null when it stopped, which shows all changes. */
  async function readSince(
    { repository: { root, github }, baseOid, head }: Range,
    reviewed: Oid,
    isCurrent: () => boolean,
    set: (read: SinceRead) => void,
  ): Promise<SinceReady | null> {
    const stopped = (stop: SinceStop) => {
      set({ kind: "stopped", stop });
      return null;
    };
    const look = () => deps.sinceReview(root, baseOid, reviewed, head);
    try {
      let found = await look();
      if (found.kind === "missing" && isCurrent()) {
        set({ kind: "fetching" });
        const [first = reviewed, second] = found.oids;
        const got = await fetchCommits(
          root,
          github,
          second === undefined ? [first] : [first, second],
        );
        if (got.kind !== "done") return stopped(got);
        if (!isCurrent()) return null;
        found = await look();
      }
      if (found.kind === "missing") return stopped({ kind: "stillMissing" });
      if (found.kind !== "ready") return stopped(found);
      set(found);
      return found;
    } catch (error) {
      return stopped({ kind: "unreadable", problem: problemFrom(error) });
    }
  }

  async function load(
    range: Range,
    since: Since | null,
    counted: () => PullRequest,
    isCurrent: () => boolean,
    set: (change: Partial<FilesChanged>) => void,
  ) {
    const { repository, baseOid, head } = range;
    const { root, github } = repository;
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
    if (found.shallow && countsNotice(found, counted()) !== null)
      return stopped({ kind: "unrelated", shallow: true });
    const { files: listed, mergeBase, contentMissing } = found;
    const read = {
      kind: "ready",
      mergeBase,
      files: inTreeOrder(listed),
      contentMissing,
    } as const;
    if (!isCurrent() || !held) return;
    put({ ...held, read, at: atPath({ ...held, read }) });
    const reviewed = since?.read.kind === "reading" ? since.point.oid : null;
    const sinceRead =
      reviewed === null
        ? null
        : readSince(range, reviewed, isCurrent, (next) => {
            if (!isCurrent() || !held?.since) return;
            const stops = next.kind === "stopped";
            const changed = {
              ...held,
              since: {
                ...held.since,
                read: next,
                ...(stops && { showing: "all" as const }),
              },
            };
            put({ ...changed, at: atPath(changed) });
            // All changes may show a file that the patches left out.
            if (stops) readCurrent();
          });
    if (contentMissing) return;
    const patches = new Map<RangeFile, PatchRead>();
    // A file without an answer here is read by itself.
    if (listed.length > 0)
      patchesOf(
        listed,
        await deps.rangePatches(root, mergeBase, head).catch(() => []),
        patches,
      );
    set({ patches });
    if (isCurrent()) readCurrent();
    const ready = await sinceRead;
    if (!ready) return;
    if (ready.contentMissing || ready.files.length === 0) return readCurrent();
    const answers = await deps
      .rangePatches(root, ready.since, head)
      .catch(() => []);
    if (!isCurrent() || !held?.patches) return;
    const more = new Map(held.patches);
    patchesOf(ready.files, answers, more);
    put({ ...held, patches: more });
    readCurrent();
  }

  function begin(next: FilesChanged) {
    const mine = {};
    turn = mine;
    const isCurrent = () => turn === mine;
    const set = (change: Partial<FilesChanged>) => {
      if (isCurrent() && held) put({ ...held, ...change });
    };
    put(next);
    const counted = () => held?.counted ?? next.counted;
    load(next.range, next.since, counted, isCurrent, set).catch(
      (error: unknown) => {
        const stop: Stop = { kind: "unreadable", problem: problemFrom(error) };
        set({ read: { kind: "stopped", stop } });
      },
    );
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
    const since = sinceFor(newest, held.since);
    begin({ of: held.of, range, pull, counted: pull, since, ...unread });
  }

  const unread = {
    read: { kind: "reading" },
    at: 0,
    enter: "start",
    patches: null,
  } as const;

  /** What a file's patch starts from: the since read's start for its own files, else the merge base. */
  function baseOf(file: RangeFile, mergeBase: Oid): Oid {
    const read = held?.since?.read;
    return read?.kind === "ready" && read.files.includes(file)
      ? read.since
      : mergeBase;
  }

  function patchOf(file: RangeFile, context: PatchContext) {
    if (held?.read.kind !== "ready")
      return Promise.reject(new Error("The range was not read."));
    const { range, read } = held;
    return deps.filePatch(
      range.repository.root,
      {
        base: { kind: "commit", oid: baseOf(file, read.mergeBase) },
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
      if (turn === mine && held?.patches)
        put({ ...held, patches: new Map(held.patches).set(file, patch) });
    };
    set({ kind: "reading" });
    patchOf(file, "hunks").then(
      (patch) => set({ kind: "ready", patch }),
      (error: unknown) => set({ kind: "failed", problem: problemFrom(error) }),
    );
  }

  function current(): RangeFile | null {
    return held ? (shownFiles(held)[held.at] ?? null) : null;
  }

  /** A file the author changed since your review takes comments only inside the hunks of the pull request's own patch, so that is read too. */
  function readFile(file: RangeFile) {
    const now = held && sinceShown(held)?.nowOf.get(file);
    for (const each of now ? [file, now] : [file])
      if (held?.patches && !held.patches.has(each)) readPatch(each);
  }

  function readCurrent() {
    const file = current();
    if (file) readFile(file);
  }

  /** Shows another list at the same file, when it has it. */
  function change(since: Partial<Since>) {
    if (!held?.since) return;
    path = current()?.path ?? path;
    const next = { ...held, since: { ...held.since, ...since } };
    put({ ...next, at: atPath(next), enter: "start" });
    readCurrent();
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
        const range = rangeOf(repository, pull);
        const since = sinceFor(pull, null);
        put({ of, range, pull, counted: pull, since, ...unread });
        if (isComing) wait = setTimeout(showNewest, MOST_WAIT);
        else showNewest();
      } else if (wait !== null) {
        if (!isComing) showNewest();
      } else if (isNew && pull.head.oid === held.range.head)
        put({
          ...held,
          pull: withThreads(pull, held.pull),
          counted: pull.base === held.range.base ? pull : held.counted,
        });
    },
    showNewest,
    retry() {
      if (held?.read.kind !== "stopped") return;
      const { since } = held;
      begin({
        ...held,
        ...unread,
        since: since && sinceFor(held.pull, since),
      });
    },
    /** Reads what changed since your review again, after it stopped. */
    retrySince() {
      const since = held?.since;
      if (!held || since?.read.kind !== "stopped") return;
      begin({
        ...held,
        ...unread,
        since: since.point.oid === null ? since : sinceFor(held.pull, null),
      });
    },
    /** All changes, or what changed since your review, at the same file when it is there. */
    show(showing: Since["showing"]) {
      const since = held?.since;
      if (!since || since.showing === showing) return;
      if (showing === "since" && since.read.kind === "stopped") return;
      change({ showing });
    },
    /** Lists the files that only the base's changes moved after the others, or leaves them out. */
    showRebased(rebased: Since["rebased"]) {
      if (held?.since && held.since.rebased !== rebased) change({ rebased });
    },
    readFile,
    readFileAgain: readPatch,
    go(at: number, enter: FilesChanged["enter"] = "start") {
      if (!held) return;
      const file = shownFiles(held)[at];
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
