import { useEffect, useSyncExternalStore } from "react";
import * as repositories from "./repositories";
import { divergence, readyAdvances, repositoryRank } from "./domain/overview";
import type {
  Advance,
  AdvanceOutcome,
  BranchRef,
  Divergence,
  FetchSummary,
  RepositoryOverview,
} from "./domain/overview";
import { problemFrom } from "./domain/repository";
import type { Problem, RepositoryRoot } from "./domain/repository";
import type { FetchInterval } from "./fetchSettings";

export type RootState =
  | { kind: "opening" }
  | { kind: "unavailable"; problem: Problem }
  | { kind: "open"; commonDir: RepositoryRoot };

export type Activity =
  | { kind: "idle" }
  | { kind: "fetching" }
  | { kind: "updating"; branches: ReadonlySet<BranchRef> };

export type FetchStatus =
  | { kind: "never" }
  | { kind: "fetched"; at: number; remotes: FetchSummary["remotes"] }
  | { kind: "failed"; at: number; problem: Problem };

export type RepositoryState = {
  commonDir: RepositoryRoot;
  roots: readonly RepositoryRoot[];
  overview: RepositoryOverview;
  activity: Activity;
  fetch: FetchStatus;
  outcomes: ReadonlyMap<BranchRef, AdvanceOutcome>;
};

export type RootSync = {
  head: { name: string; divergence: Divergence } | null;
  branches: ReadonlyMap<string, Divergence>;
};

export type OverviewView = {
  roots: ReadonlyMap<RepositoryRoot, RootState>;
  repositories: readonly RepositoryState[];
  syncByRoot: ReadonlyMap<RepositoryRoot, RootSync>;
};

export type OverviewDeps = {
  overview: typeof repositories.overview;
  fastForward: typeof repositories.fastForward;
  now: () => number;
  every: (run: () => void, ms: number) => () => void;
  visible: () => boolean;
  onVisibilityChange: (run: () => void) => () => void;
};

export type OverviewStore = {
  subscribe(listener: () => void): () => void;
  getSnapshot(): OverviewView;
  track(roots: readonly RepositoryRoot[]): void;
  fetch(commonDir?: RepositoryRoot): Promise<void>;
  fastForward(commonDir: RepositoryRoot, branch: BranchRef): Promise<void>;
  updateAll(commonDir?: RepositoryRoot): Promise<void>;
  setInterval(minutes: FetchInterval): void;
  onRefsChanged(listener: (roots: RepositoryRoot[]) => void): () => void;
  dispose(): void;
};

type Request =
  | { kind: "fetch" }
  | { kind: "fastForward"; advances: Map<BranchRef, Advance> };
type Job = { request: Request; done: Promise<void>; finish: () => void };
type Repository = Omit<RepositoryState, "commonDir" | "roots"> & {
  running: Job | null;
  queue: Job[];
};

const idle: Activity = { kind: "idle" };

export function createOverviewStore(deps: OverviewDeps): OverviewStore {
  const listeners = new Set<() => void>();
  const refListeners = new Set<(roots: RepositoryRoot[]) => void>();
  let tracked: readonly RepositoryRoot[] = [];
  const roots = new Map<RepositoryRoot, RootState>();
  const repos = new Map<RepositoryRoot, Repository>();
  let intervalMinutes: FetchInterval = 0;
  let stopTimer: (() => void) | null = null;
  let missedTick = false;
  let view = buildView();
  const stopVisibility = deps.onVisibilityChange(() => {
    if (!missedTick || !deps.visible()) return;
    missedTick = false;
    void fetch();
  });

  function emit() {
    view = buildView();
    for (const listener of listeners) listener();
  }

  function rootsOf(commonDir: RepositoryRoot): RepositoryRoot[] {
    return tracked.filter((root) => {
      const state = roots.get(root);
      return state?.kind === "open" && state.commonDir === commonDir;
    });
  }

  function buildView(): OverviewView {
    const states: RepositoryState[] = [...repos].map(([commonDir, repo]) => ({
      commonDir,
      roots: rootsOf(commonDir),
      overview: repo.overview,
      activity: repo.activity,
      fetch: repo.fetch,
      outcomes: repo.outcomes,
    }));
    const fetchFailed = ({ fetch }: RepositoryState) =>
      fetch.kind === "failed" ||
      (fetch.kind === "fetched" &&
        fetch.remotes.some(({ outcome }) => outcome.kind === "failed"));
    states.sort(
      (a, b) =>
        repositoryRank(a.overview, fetchFailed(a)) -
          repositoryRank(b.overview, fetchFailed(b)) ||
        a.overview.name.localeCompare(b.overview.name),
    );
    const syncByRoot = new Map<RepositoryRoot, RootSync>();
    for (const state of states) {
      const tracking = state.overview.branches.flatMap((branch) => {
        const sync = divergence(branch.state);
        return sync === null ? [] : [{ branch, divergence: sync }];
      });
      const branches = new Map<string, Divergence>(
        tracking.map((entry) => [entry.branch.reference, entry.divergence]),
      );
      for (const root of state.roots) {
        const head = tracking.find(
          ({ branch }) => branch.checkedOutAt === root,
        );
        syncByRoot.set(root, {
          head: head
            ? { name: head.branch.name, divergence: head.divergence }
            : null,
          branches,
        });
      }
    }
    return {
      roots: new Map(roots),
      repositories: states,
      syncByRoot,
    };
  }

  function notifyRefsChanged(commonDir: RepositoryRoot) {
    const changed = rootsOf(commonDir);
    for (const listener of refListeners) listener(changed);
  }

  async function open(root: RepositoryRoot) {
    const opening: RootState = { kind: "opening" };
    roots.set(root, opening);
    let overview: RepositoryOverview;
    try {
      overview = await deps.overview(root, "local");
    } catch (error) {
      if (roots.get(root) !== opening) return;
      roots.set(root, { kind: "unavailable", problem: problemFrom(error) });
      emit();
      return;
    }
    if (roots.get(root) !== opening) return;
    roots.set(root, { kind: "open", commonDir: overview.commonDir });
    if (!repos.has(overview.commonDir)) {
      repos.set(overview.commonDir, {
        overview,
        activity: idle,
        fetch: { kind: "never" },
        outcomes: new Map(),
        running: null,
        queue: [],
      });
      void enqueue(overview.commonDir, { kind: "fetch" });
    }
    emit();
  }

  function enqueue(commonDir: RepositoryRoot, request: Request): Promise<void> {
    const repo = repos.get(commonDir);
    if (!repo) return Promise.resolve();
    const pending = [...(repo.running ? [repo.running] : []), ...repo.queue];
    if (request.kind === "fetch") {
      const joined = pending.find((job) => job.request.kind === "fetch");
      if (joined) return joined.done;
    } else {
      const queued = repo.queue.find(
        (job) => job.request.kind === "fastForward",
      );
      if (queued?.request.kind === "fastForward") {
        for (const [reference, advance] of request.advances)
          queued.request.advances.set(reference, advance);
        return queued.done;
      }
    }
    let finish = () => {};
    const done = new Promise<void>((resolve) => (finish = resolve));
    repo.queue.push({ request, done, finish });
    void pump(commonDir, repo);
    return done;
  }

  async function pump(commonDir: RepositoryRoot, repo: Repository) {
    if (repo.running) return;
    const job = repo.queue.shift();
    if (!job) return;
    repo.running = job;
    try {
      await run(commonDir, repo, job.request);
    } finally {
      repo.running = null;
      repo.activity = idle;
      job.finish();
      if (repos.get(commonDir) === repo) {
        emit();
        void pump(commonDir, repo);
      }
    }
  }

  async function run(
    commonDir: RepositoryRoot,
    repo: Repository,
    request: Request,
  ) {
    const root = rootsOf(commonDir)[0];
    if (root === undefined) return;
    if (request.kind === "fetch") {
      repo.activity = { kind: "fetching" };
      emit();
      try {
        const overview = await deps.overview(root, "remote");
        repo.overview = overview;
        repo.fetch = {
          kind: "fetched",
          at: deps.now(),
          remotes: overview.fetch?.remotes ?? [],
        };
        repo.outcomes = new Map();
        if (overview.fetch?.changed && repos.get(commonDir) === repo)
          notifyRefsChanged(commonDir);
      } catch (error) {
        repo.fetch = {
          kind: "failed",
          at: deps.now(),
          problem: problemFrom(error),
        };
      }
      return;
    }
    const advances = [...request.advances.values()];
    repo.activity = {
      kind: "updating",
      branches: new Set(request.advances.keys()),
    };
    emit();
    let outcomes: AdvanceOutcome[];
    try {
      const report = await deps.fastForward(root, advances);
      repo.overview = report.overview;
      outcomes = report.outcomes;
    } catch (error) {
      const { message } = problemFrom(error);
      outcomes = advances.map(({ reference }) => ({
        kind: "skipped",
        reference,
        reason: { kind: "failed", message },
      }));
    }
    repo.outcomes = new Map([
      ...repo.outcomes,
      ...outcomes.map((outcome) => [outcome.reference, outcome] as const),
    ]);
    if (
      outcomes.some(({ kind }) => kind === "advanced") &&
      repos.get(commonDir) === repo
    )
      notifyRefsChanged(commonDir);
  }

  function fetch(commonDir?: RepositoryRoot): Promise<void> {
    if (commonDir !== undefined) return enqueue(commonDir, { kind: "fetch" });
    for (const [root, state] of roots)
      if (state.kind === "unavailable") void open(root);
    emit();
    return Promise.all(
      [...repos.keys()].map((dir) => enqueue(dir, { kind: "fetch" })),
    ).then(() => {});
  }

  function fastForwardAll(
    commonDir: RepositoryRoot,
    advances: Advance[],
  ): Promise<void> {
    if (advances.length === 0) return Promise.resolve();
    return enqueue(commonDir, {
      kind: "fastForward",
      advances: new Map(
        advances.map((advance) => [advance.reference, advance]),
      ),
    });
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => view,
    track(next) {
      const changed =
        next.length !== tracked.length ||
        next.some((root, index) => tracked[index] !== root);
      if (!changed) return;
      tracked = [...next];
      for (const root of [...roots.keys()])
        if (!tracked.includes(root)) roots.delete(root);
      for (const commonDir of [...repos.keys()])
        if (rootsOf(commonDir).length === 0) repos.delete(commonDir);
      for (const root of tracked) if (!roots.has(root)) void open(root);
      emit();
    },
    fetch,
    fastForward(commonDir, branch) {
      const repo = repos.get(commonDir);
      if (!repo) return Promise.resolve();
      return fastForwardAll(
        commonDir,
        readyAdvances(repo.overview).filter(
          ({ reference }) => reference === branch,
        ),
      );
    },
    updateAll(commonDir) {
      return Promise.all(
        [...repos]
          .filter(([dir]) => commonDir === undefined || dir === commonDir)
          .map(([dir, repo]) =>
            fastForwardAll(dir, readyAdvances(repo.overview)),
          ),
      ).then(() => {});
    },
    setInterval(minutes) {
      if (minutes === intervalMinutes) return;
      intervalMinutes = minutes;
      stopTimer?.();
      stopTimer = null;
      missedTick = false;
      if (minutes === 0) return;
      stopTimer = deps.every(() => {
        if (deps.visible()) void fetch();
        else missedTick = true;
      }, minutes * 60_000);
    },
    onRefsChanged(listener) {
      refListeners.add(listener);
      return () => refListeners.delete(listener);
    },
    dispose() {
      stopTimer?.();
      stopVisibility();
      listeners.clear();
      refListeners.clear();
    },
  };
}

let singleton: OverviewStore | null = null;

export function overviewStore(): OverviewStore {
  singleton ??= createOverviewStore({
    overview: repositories.overview,
    fastForward: repositories.fastForward,
    now: Date.now,
    every(run, ms) {
      const handle = window.setInterval(run, ms);
      return () => window.clearInterval(handle);
    },
    visible: () => document.visibilityState === "visible",
    onVisibilityChange(run) {
      document.addEventListener("visibilitychange", run);
      return () => document.removeEventListener("visibilitychange", run);
    },
  });
  return singleton;
}

export function useOverview(
  roots: readonly RepositoryRoot[],
  intervalMinutes: FetchInterval,
) {
  const store = overviewStore();
  useEffect(() => store.track(roots), [store, roots]);
  useEffect(() => store.setInterval(intervalMinutes), [store, intervalMinutes]);
  const view = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return { view, store };
}

const failureLabel = {
  auth: "Authentication failed",
  network: "Network error",
  timedOut: "Timed out",
  busy: "Repository busy",
  other: "Fetch failed",
} as const;

export function repositoryWarnings(
  repo: Pick<RepositoryState, "fetch" | "outcomes">,
): string[] {
  const fetch =
    repo.fetch.kind === "failed"
      ? [`Could not fetch. ${repo.fetch.problem.message}`]
      : repo.fetch.kind === "fetched"
        ? repo.fetch.remotes.flatMap(({ remote, outcome }) =>
            outcome.kind === "failed"
              ? [
                  `${remote}: ${failureLabel[outcome.failure]}. ${outcome.message}`,
                ]
              : [],
          )
        : [];
  const skipped = [...repo.outcomes.values()].flatMap((outcome) =>
    outcome.kind === "skipped"
      ? [
          `Did not fast-forward ${outcome.reference.replace(/^refs\/heads\//, "")}. ${skipText(outcome.reason)}`,
        ]
      : [],
  );
  return [...fetch, ...skipped];
}

function skipText(
  reason: Extract<AdvanceOutcome, { kind: "skipped" }>["reason"],
): string {
  switch (reason.kind) {
    case "changed":
      return "It moved since the last fetch. Fetch again.";
    case "notBehind":
      return "It is no longer behind its upstream. Fetch again.";
    case "dirty":
      return `Uncommitted changes in ${baseName(reason.worktree)}. Commit or stash first.`;
    case "inUse":
      return `${baseName(reason.worktree)} is in the middle of a merge, rebase, or other operation.`;
    case "failed":
      return reason.message;
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

function baseName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}
