import { detailSchema } from "../domain/repository";
import type {
  Applied,
  Problem,
  RepositoryRoot,
  RepositorySnapshot,
  UndoHistory,
  WorktreeStatus,
} from "../domain/repository";
import { mergeSelectionSchema } from "../domain/merge";
import type { MergeState } from "../domain/merge";
import type { RepositoryOverview } from "../domain/overview";
import type { PushAvailability } from "../domain/push";
import type { Comparison } from "../domain/comparison";
import {
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
};

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
  };
}

type Handler = (request: BridgeRequest, world: World) => unknown;

const missing = (path: string): Problem => ({
  kind: "missingPath",
  message: `${path} is not in the fake bridge.`,
});

class Refusal {
  constructor(readonly problem: Problem) {}
}

function known<T>(map: Map<RepositoryRoot, T>, path: string): T {
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
  conflictFile: (request) =>
    editableConflict(request.path, String(request.file)),
  lineStats: () => [],
  filePatch: () => ({
    kind: "text",
    patch: "--- a/notes.txt\n+++ b/notes.txt\n@@ -1 +1 @@\n-old\n+new\n",
    lossy: false,
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
  undo: (request, world) => step(request, world, "undo"),
  redo: (request, world) => step(request, world, "redo"),
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
  if (request.op === "overview") parts.push(String(request.mode));
  if (request.op === "write")
    parts.push((request.operation as { kind: string }).kind);
  if (request.op === "filePatch" || request.op === "worktreePatch")
    parts.push(String(request.file));
  return parts.join(" ");
}

export function createBridge(world: World = createWorld()) {
  const log: BridgeRequest[] = [];
  const unexpected: string[] = [];
  const holds: Hold[] = [];
  const overrides = new Map<string, Handler>();
  let active = 0;

  function answer(request: BridgeRequest): unknown {
    const handler = overrides.get(request.op) ?? handlers[request.op];
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

  async function fetch(input: unknown, init?: RequestInit): Promise<Response> {
    if (input !== "/api/run" || typeof init?.body !== "string") {
      unexpected.push(String(input));
      throw new Error(`The fake bridge does not serve ${String(input)}.`);
    }
    const request = JSON.parse(init.body) as BridgeRequest;
    log.push(request);
    const hold = holds.find(
      (candidate) =>
        !candidate.taken &&
        candidate.op === request.op &&
        (candidate.path === undefined || candidate.path === request.path),
    );
    if (hold) {
      hold.taken = true;
      hold.arrived.resolve();
      await hold.gate.promise;
    }
    active += 1;
    try {
      await Promise.resolve();
      const body = JSON.stringify(answer(request));
      return {
        ok: true,
        status: 200,
        json: async () => JSON.parse(body) as unknown,
      } as Response;
    } finally {
      active -= 1;
    }
  }

  return {
    world,
    fetch,
    log,
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
