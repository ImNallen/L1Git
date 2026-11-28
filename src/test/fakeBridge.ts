import {
  detailSchema,
  replayOfSchema,
  worktreeSourceSchema,
} from "../domain/repository";
import type {
  Applied,
  Problem,
  RepositoryRoot,
  RepositorySnapshot,
  UndoHistory,
  WorktreeStatus,
} from "../domain/repository";
import type {
  GhProbe,
  HostOpenPull,
  HostProblem,
  HostStatus,
} from "../domain/host";
import type { DraftChange } from "../domain/drafts";
import type {
  PullRequest,
  PullRequestList,
  PullRequests,
} from "../domain/pullRequest";
import type { GitHubRepository } from "../domain/repository";
import {
  rangeFilesSchema,
  rangePatchesSchema,
  sinceReviewSchema,
} from "../domain/range";
import { pullCopyHandlers } from "./fakePullCopies";
import { openContextHandler, openPullHandler } from "./fakeOpenPulls";
import type { FakeOpen, OpenScript } from "./fakeOpenPulls";
import { draftsHandler } from "./fakeDrafts";
import type { FakeSent } from "./fakeDrafts";
import { checkHandler, sendAgainArrives, writeArrives } from "./fakeWrites";
import type { WriteScript } from "./fakeWrites";
import type { PullWrite } from "../domain/pullRequestWrites";
import type { Draft, Waiting } from "../domain/drafts";
import type { Wrote } from "../domain/host";
import type { PullCopy } from "./fakePullCopies";
import { mergeSelectionSchema } from "../domain/merge";
import { probeOf } from "../domain/inProgress";
import type { MergeState } from "../domain/merge";
import type { RepositoryOverview } from "../domain/overview";
import type { PushAvailability } from "../domain/push";
import type { Comparison } from "../domain/comparison";
import type { DirectoryEntry } from "../domain/addRepository";
import {
  addEmptyRepository,
  addLinkedWorktree,
  applied,
  deleteGoneBranch,
  editableConflict,
  featureStatus,
  history,
  idleMerge,
  mergeReviewFor,
  noUpstream,
  OTHER,
  otherOverview,
  otherSnapshot,
  otherStatus,
  PIN,
  PIN_FEATURE,
  pinOverview,
  pinSnapshot,
  pinStatus,
  readyPush,
  removeLinkedWorktree,
  replayReviewFor,
} from "./fixtures";

export type BridgeRequest = { op: string; path: string } & Record<
  string,
  unknown
>;

export type World = {
  snapshots: Map<RepositoryRoot, RepositorySnapshot>;
  statuses: Map<RepositoryRoot, WorktreeStatus>;
  histories: Map<RepositoryRoot, UndoHistory>;
  merges: Map<RepositoryRoot, MergeState>;
  overviews: Map<RepositoryRoot, RepositoryOverview>;
  pushes: Map<RepositoryRoot, PushAvailability>;
  /** Each pull request's copy by its repository's main worktree root and
   * number, as `${root} #${number}`. */
  pullCopies: Map<string, PullCopy>;
  /** Commits that sit on top of another, as an author pushes them to a pull
   * request or you commit in its copy. A fetch of the head brings it and the
   * commits under it into the clone. Try makes a copy at any head. */
  pullCommits: Map<string, { parent: string; fetched: boolean }>;
  /** What each typed path lists. An open repository lists itself. */
  directories: Map<string, DirectoryEntry[]>;
  host: {
    status: HostStatus;
    probe: GhProbe;
    /** Each list by `pullsKey`. GitHub does not find a repository without one. */
    pulls: Map<string, PullRequests>;
    /** Each pull request by `pullKey`. */
    details: Map<string, PullRequest>;
    /** The drafts on this computer, by login and `pullKey`, as the host keeps
     * them in drafts.json. */
    drafts: Map<string, Draft[]>;
    /** The writes drafts.json keeps from before each leaves until its outcome
     * is known, by login and `pullKey`, with the drafts they carry. */
    sent: Map<string, FakeSent[]>;
    waiting: Map<string, Waiting[]>;
    /** What the next writes answer, in order. A write with none left is done
     * and changes `details` as GitHub would. */
    writes: WriteScript[];
    /** Every write that reached GitHub, in order. */
    mutations: PullWrite[];
    /** The open pull requests opening one looks for, by `owner/repo`. */
    opens: Map<string, FakeOpen[]>;
    /** What the next openings answer, in order. */
    openScript: OpenScript[];
    /** Every opening that reached GitHub, in order. */
    openings: HostOpenPull["open"][];
    /** Repository ids by `owner/repo`, for a name that now belongs to
     * another repository than `repositoryIdOf` says. */
    ids: Map<string, string>;
  };
};

export const pullsKey = (name: string, list: PullRequestList) =>
  `${name} ${list}`;
export const pullKey = (name: string, number: number) => `${name}#${number}`;
const repositoryName = ({ owner, repo }: GitHubRepository) =>
  `${owner}/${repo}`;

export const FAKE_HOME = "/fixture/home";

export const fromHome = (path: string) => path.replace(/^~(?=\/|$)/, FAKE_HOME);

export const folder = (
  path: string,
  kind: DirectoryEntry["kind"],
): DirectoryEntry => ({
  name: path.split("/").at(-1) ?? path,
  path,
  kind,
});

export function createWorld(): World {
  return {
    snapshots: new Map([
      [PIN, pinSnapshot()],
      [OTHER, otherSnapshot()],
    ]),
    statuses: new Map([
      [PIN, pinStatus()],
      [PIN_FEATURE, featureStatus()],
      [OTHER, otherStatus()],
    ]),
    histories: new Map([[PIN, history(deleteGoneBranch())]]),
    merges: new Map(),
    overviews: new Map([
      [PIN, pinOverview()],
      [OTHER, otherOverview()],
    ]),
    pushes: new Map([
      [PIN, readyPush()],
      [OTHER, noUpstream()],
    ]),
    pullCopies: new Map(),
    pullCommits: new Map(),
    directories: new Map([
      ["~", [folder(`${FAKE_HOME}/Projects`, "folder")]],
      [
        "~/Projects",
        [
          folder(`${FAKE_HOME}/Projects/docs-site`, "repository"),
          folder(`${FAKE_HOME}/Projects/screenshots`, "folder"),
        ],
      ],
    ]),
    host: {
      status: {
        revision: 1,
        github: { kind: "notConnected", ended: null },
        deviceSignIn: false,
        deviceCode: null,
      },
      probe: {
        kind: "ready",
        login: "octo",
        access: "private",
        path: "/opt/homebrew/bin/gh",
      },
      pulls: new Map(),
      details: new Map(),
      drafts: new Map(),
      sent: new Map(),
      waiting: new Map(),
      writes: [],
      mutations: [],
      opens: new Map(),
      openScript: [],
      openings: [],
      ids: new Map(),
    },
  };
}

export type Handler = (request: BridgeRequest, world: World) => unknown;

const missing = (path: string): Problem => ({
  kind: "missingPath",
  message: `${path} is not in the fake bridge.`,
});

export class Refusal {
  constructor(readonly problem: Problem) {}
}

export function known<T>(map: Map<RepositoryRoot, T>, path: string): T {
  const found = map.get(path as RepositoryRoot);
  if (found === undefined) throw new Refusal(missing(path));
  return found;
}

function commitDetail(request: BridgeRequest, world: World) {
  const comparison = request.comparison as Comparison;
  const snapshot = known(world.snapshots, request.path);
  const { target } = comparison;
  if (target.kind === "worktree")
    return detailSchema.parse({
      base: { kind: "firstParent" },
      target: {
        kind: "worktree",
        root: target.root,
        head: known(world.statuses, target.root).head,
      },
      files: [{ path: "notes.txt", status: "M" }],
    });
  const stash = snapshot.stashes.find((entry) => entry.oid === target.oid);
  const commit = snapshot.commits.find((entry) => entry.oid === target.oid) ?? {
    oid: target.oid,
    parents: [],
    subject: stash?.message ?? "Unlisted commit",
    author: "Pin Author",
    email: "pin@example.com",
    timestamp: 1_700_000_000,
  };
  return detailSchema.parse({
    base: { kind: "firstParent" },
    target: { kind: "commit", commit, message: `${commit.subject}\n` },
    files: [{ path: "notes.txt", status: "M" }],
  });
}

function step(request: BridgeRequest, world: World, from: "undo" | "redo") {
  const shown = world.histories.get(request.path as RepositoryRoot);
  const entry = shown?.[from];
  if (!entry || entry.id !== request.id)
    throw new Refusal({
      kind: "staleView",
      reason: "historyChanged",
      message: "The fake bridge has no such entry.",
    });
  world.histories.set(
    request.path as RepositoryRoot,
    from === "undo" ? history(null, entry) : history(entry, null),
  );
  return entry;
}

/** What Try it locally would do, by Check out's rules for an origin-style refspec. */
function worktreeReview(request: BridgeRequest, world: World) {
  const snapshot = known(world.snapshots, request.path);
  const source = worktreeSourceSchema.parse(request.source);
  const name =
    source.kind === "local"
      ? source.reference.replace(/^refs\/heads\//, "")
      : source.reference.replace(/^refs\/remotes\/[^/]+\//, "");
  const reference = `refs/heads/${name}`;
  const holder = snapshot.worktrees.find(
    ({ head }) => head.kind === "attached" && head.reference === reference,
  );
  if (holder)
    throw new Refusal({
      kind: "conflict",
      message: `${name} is checked out in ${holder.root}, and Git checks out a branch in one worktree at a time. Switch that worktree to another branch first.`,
    });
  const main = snapshot.worktrees.find((worktree) => worktree.main) ?? snapshot;
  const parent = main.root.split("/").slice(0, -1).join("/");
  return {
    folder: `${parent}/.worktrees/${main.name}-${name.replaceAll("/", "-")}`,
    branch: snapshot.branches.some((branch) => branch.reference === reference)
      ? { kind: "existing", reference }
      : { kind: "new", reference, upstream: source.reference },
    name,
  };
}

const handlers: Record<string, Handler> = {
  snapshot: (request, world) => known(world.snapshots, request.path),
  refs: (request, world) => {
    const { root, name, head, branches, tags, stashes, submodules } = known(
      world.snapshots,
      request.path,
    );
    return { root, name, head, branches, tags, stashes, submodules };
  },
  worktreeStatus: (request, world) => known(world.statuses, request.path),
  undoHistory: (request, world) =>
    world.histories.get(request.path as RepositoryRoot) ?? history(null),
  mergeState: (request, world) =>
    world.merges.get(request.path as RepositoryRoot) ?? idleMerge(),
  operationProbe: (request, world) =>
    probeOf(
      world.merges.get(request.path as RepositoryRoot) ?? idleMerge(),
      undefined,
    ),
  overview: (request, world) => known(world.overviews, request.path),
  preparePush: (request, world) => known(world.pushes, request.path),
  commitDetail,
  mergeReview: (request) => {
    const review = mergeReviewFor(request.path as RepositoryRoot);
    const selection = mergeSelectionSchema.parse(request.selection);
    return selection.kind === "upstream"
      ? review
      : {
          ...review,
          source: { ...review.source, reference: selection.reference },
          context: { kind: "branch" },
        };
  },
  replayReview: (request) =>
    replayReviewFor(
      request.path as RepositoryRoot,
      replayOfSchema.parse(request.of),
    ),
  replayAbort: (request, world) => {
    world.merges.delete(request.path as RepositoryRoot);
    return idleMerge();
  },
  conflictFile: (request) =>
    editableConflict(request.path, String(request.file)),
  conflictSummary: (request, world) => {
    const state = world.merges.get(request.path as RepositoryRoot);
    const unresolved =
      state?.kind === "active"
        ? state.unresolved
        : state?.kind === "replay"
          ? state.progress.unresolved
          : [];
    return unresolved.map((path) => ({ kind: "text", path, conflicts: 1 }));
  },
  wholeFileConflict: () => null,
  lineStats: () => [],
  filePatch: () => ({
    kind: "text",
    patch: "--- a/notes.txt\n+++ b/notes.txt\n@@ -1 +1 @@\n-old\n+new\n",
    lossy: false,
  }),
  rangeFiles: (request) =>
    rangeFilesSchema.parse({
      kind: "ready",
      mergeBase: request.base,
      files: [
        {
          path: "notes.txt",
          status: "M",
          from: null,
          similarity: null,
          added: 1,
          deleted: 1,
          oldBlob: request.base,
          newBlob: request.head,
          oldMode: "100644",
          newMode: "100644",
          submodule: false,
        },
      ],
      contentMissing: false,
      shallow: false,
    }),
  rangePatches: () =>
    rangePatchesSchema.parse([
      {
        path: "notes.txt",
        patch: {
          kind: "text",
          patch: "--- a/notes.txt\n+++ b/notes.txt\n@@ -1 +1 @@\n-old\n+new\n",
          lossy: false,
        },
      },
    ]),
  fetchCommits: () => ({ kind: "done" }),
  /** The base did not move, and nothing changed since the review. */
  sinceReview: (request) =>
    sinceReviewSchema.parse({
      kind: "ready",
      since: request.reviewed,
      fromBase: { kind: "none" },
      reviewed: [],
      files: [],
      contentMissing: false,
    }),
  worktreePatch: () => ({
    kind: "diff",
    diff: {
      kind: "text",
      patch: "--- a/notes.txt\n+++ b/notes.txt\n@@ -1 +1 @@\n-old\n+new\n",
      lossy: false,
    },
  }),
  write: (request) =>
    applied(
      request.path as RepositoryRoot,
      request.operation as Applied["operation"],
    ),
  home: () => FAKE_HOME,
  listDirectories: (request, world) => ({
    entries:
      world.directories.get(request.path) ??
      (world.snapshots.has(request.path as RepositoryRoot)
        ? [folder(request.path, "repository")]
        : []),
  }),
  createRepository: (request, world) => {
    const path = fromHome(request.path);
    addEmptyRepository(world, path as RepositoryRoot);
    return { path };
  },
  cloneRepository: (request, world) => {
    const path = fromHome(request.path);
    addEmptyRepository(world, path as RepositoryRoot);
    return { path };
  },
  worktreeReview: (request, world) => {
    const { folder, branch } = worktreeReview(request, world);
    return { folder, branch };
  },
  createWorktree: (request, world) => {
    const { name } = worktreeReview(request, world);
    const root = fromHome(String(request.folder)) as RepositoryRoot;
    addLinkedWorktree(world, request.path as RepositoryRoot, root, name);
    return { root, name: root.split("/").at(-1), trouble: null };
  },
  removeWorktree: (request, world) => {
    removeLinkedWorktree(world, request.worktree as RepositoryRoot);
    return undefined;
  },
  undo: (request, world) => step(request, world, "undo"),
  redo: (request, world) => step(request, world, "redo"),
  ...pullCopyHandlers,
};

class HostRefusal {
  constructor(readonly problem: HostFailure) {}
}

type HostFailure = Pick<HostProblem, "kind" | "message"> &
  Record<string, unknown>;

/** What a held or failed host request names, for `hold` and `failHost`. */
const hostPath = (request: BridgeRequest) =>
  request.repository === undefined
    ? undefined
    : repositoryName(request.repository as GitHubRepository);

const hostHandlers: Record<
  string,
  (request: BridgeRequest, host: World["host"]) => unknown
> = {
  status: () => undefined,
  verify: () => undefined,
  probeGh: (_, host) => host.probe,
  connectGh: (request, host) => {
    host.status = {
      ...host.status,
      revision: host.status.revision + 1,
      github: {
        kind: "connected",
        login: String(request.login),
        api: "https://api.github.com/",
        method: "gh",
        access: host.probe.kind === "ready" ? host.probe.access : "private",
        connectedAt: 1_700_000_000,
      },
    };
    return undefined;
  },
  pullRequests: (request, host) => {
    const name = String(hostPath(request));
    const found = host.pulls.get(
      pullsKey(name, request.list as PullRequestList),
    );
    if (found) return found;
    throw new HostRefusal({
      kind: "notFound",
      message: `L1 Git can't find ${name} on GitHub.`,
    });
  },
  pullRequest: (request, host) => {
    const key = pullKey(String(hostPath(request)), Number(request.number));
    const found = host.details.get(key);
    if (found) return found;
    throw new HostRefusal({
      kind: "notFound",
      message: `L1 Git can't find ${key} on GitHub.`,
    });
  },
  drafts: (request, host) =>
    draftsHandler(
      `${String(request.login)} ${pullKey(String(hostPath(request)), Number(request.number))}`.toLowerCase(),
      request.change as DraftChange,
      host,
    ),
  openPullContext: (request, host) =>
    openContextHandler(
      request as unknown as Parameters<typeof openContextHandler>[0],
      host,
    ),
  openPull: (request, host) =>
    openPullHandler(request as unknown as HostOpenPull, host),
  check: (request, host) =>
    checkHandler(
      request as unknown as Parameters<typeof checkHandler>[0],
      host,
    ),
  disconnect: (_, host) => {
    host.status = {
      ...host.status,
      revision: host.status.revision + 1,
      github: { kind: "notConnected", ended: null },
    };
    return undefined;
  },
};

/** Writes take their pull request and are kept before the bridge holds
 * them, as the host does before the mutation leaves. */
const hostArrivals: Record<
  string,
  (request: BridgeRequest, host: World["host"]) => () => Wrote
> = {
  write: (request, host) =>
    writeArrives(
      request as unknown as Parameters<typeof writeArrives>[0],
      host,
    ),
  sendAgain: (request, host) =>
    sendAgainArrives(
      request as unknown as Parameters<typeof sendAgainArrives>[0],
      host,
    ),
};

type Deferred = { promise: Promise<void>; resolve: () => void };
function deferred(): Deferred {
  let resolve = () => {};
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

type Hold = {
  op: string;
  path: string | undefined;
  gate: Deferred;
  arrived: Deferred;
  taken: boolean;
};

type Held = {
  arrived: Promise<void>;
  release(): void;
};

function line(request: BridgeRequest): string {
  const parts = [request.op, request.path];
  if (request.op === "overview") {
    const mode = request.mode as string | { branch: string };
    parts.push(typeof mode === "string" ? mode : mode.branch);
  }
  if (request.op === "write")
    parts.push((request.operation as { kind: string }).kind);
  if (request.op === "filePatch" || request.op === "worktreePatch")
    parts.push(String(request.file));
  return parts.join(" ");
}

export function createBridge(world: World = createWorld()) {
  const log: BridgeRequest[] = [];
  const hostLog: BridgeRequest[] = [];
  const unexpected: string[] = [];
  const holds: Hold[] = [];
  const overrides = new Map<string, Handler>();
  const hostFailures: { name: string | undefined; problem: HostFailure }[] = [];
  let active = 0;

  function answer(request: BridgeRequest): unknown {
    const handler = overrides.get(request.op) ?? handlers[request.op];
    if (request.op === "cancelClone") return { ok: true, op: request.op };
    if (handler === undefined) {
      unexpected.push(line(request));
      throw new Error(`The fake bridge has no answer for ${request.op}.`);
    }
    try {
      return { ok: true, op: request.op, data: handler(request, world) };
    } catch (error) {
      if (error instanceof Refusal) return { ok: false, error: error.problem };
      throw error;
    }
  }

  function answerHost(request: BridgeRequest): unknown {
    const handler = hostHandlers[request.op];
    if (handler === undefined) {
      unexpected.push(`host ${request.op}`);
      throw new Error(`The fake bridge has no host answer for ${request.op}.`);
    }
    const { status } = world.host;
    try {
      const path = hostPath(request);
      const one = pullKey(String(path), Number(request.number));
      const failure = hostFailures.findLast(
        ({ name }) => name === undefined || name === path || name === one,
      );
      if (failure && path !== undefined) throw new HostRefusal(failure.problem);
      const data = handler(request, world.host);
      return { ok: true, op: request.op, data, status: world.host.status };
    } catch (error) {
      if (error instanceof HostRefusal)
        return { ok: false, error: { ...error.problem, status } };
      throw error;
    }
  }

  async function held(op: string, path: string | undefined) {
    const hold = holds.find(
      (candidate) =>
        !candidate.taken &&
        candidate.op === op &&
        (candidate.path === undefined || candidate.path === path),
    );
    if (!hold) return;
    hold.taken = true;
    hold.arrived.resolve();
    await hold.gate.promise;
  }

  async function reply(answer: () => unknown): Promise<Response> {
    active += 1;
    try {
      await Promise.resolve();
      const body = JSON.stringify(answer());
      return {
        ok: true,
        status: 200,
        json: async () => JSON.parse(body) as unknown,
      } as Response;
    } finally {
      active -= 1;
    }
  }

  async function fetch(input: unknown, init?: RequestInit): Promise<Response> {
    if (
      (input !== "/api/run" && input !== "/api/host") ||
      typeof init?.body !== "string"
    ) {
      unexpected.push(String(input));
      throw new Error(`The fake bridge does not serve ${String(input)}.`);
    }
    const request = JSON.parse(init.body) as BridgeRequest;
    if (input === "/api/host") {
      hostLog.push(request);
      const arrived = hostArrivals[request.op]?.(request, world.host);
      await held(request.op, hostPath(request));
      return reply(() =>
        arrived
          ? {
              ok: true,
              op: request.op,
              data: arrived(),
              status: world.host.status,
            }
          : answerHost(request),
      );
    }
    log.push(request);
    await held(request.op, request.path);
    return reply(() => answer(request));
  }

  return {
    world,
    fetch,
    log,
    hostLog,
    unexpected,
    active: () => active,
    lines: (filter?: (request: BridgeRequest) => boolean) =>
      log.filter(filter ?? (() => true)).map(line),
    count: (op: string, path?: string) =>
      log.filter(
        (request) =>
          request.op === op && (path === undefined || request.path === path),
      ).length,
    reset: () => {
      log.length = 0;
    },
    hold(op: string, path?: string): Held {
      const hold: Hold = {
        op,
        path,
        gate: deferred(),
        arrived: deferred(),
        taken: false,
      };
      holds.push(hold);
      return {
        arrived: hold.arrived.promise,
        release: () => {
          holds.splice(holds.indexOf(hold), 1);
          hold.gate.resolve();
        },
      };
    },
    fail(op: string, problem: Problem, path?: string) {
      const previous = overrides.get(op);
      overrides.set(op, (request, state) => {
        if (path === undefined || request.path === path)
          throw new Refusal(problem);
        return (previous ?? handlers[op])?.(request, state);
      });
      return () => {
        if (previous) overrides.set(op, previous);
        else overrides.delete(op);
      };
    },
    /** Fails every read of a repository on GitHub, or only of `name`, which
     * can be a `pullKey`. */
    failHost(problem: HostFailure, name?: string) {
      const failure = { name, problem };
      hostFailures.push(failure);
      return () => {
        hostFailures.splice(hostFailures.indexOf(failure), 1);
      };
    },
    respond(
      op: string,
      handler: (
        request: BridgeRequest,
        world: World,
        fallback: () => unknown,
      ) => unknown,
    ) {
      const previous = overrides.get(op) ?? handlers[op];
      overrides.set(op, (request, state) =>
        handler(request, state, () => previous?.(request, state)),
      );
    },
  };
}

export type Bridge = ReturnType<typeof createBridge>;
