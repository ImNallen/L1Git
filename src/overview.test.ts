import { describe, expect, it } from "vitest";
import {
  branchRefSchema,
  fastForwardReportSchema,
  overviewSchema,
} from "./domain/overview";
import type {
  Advance,
  FastForwardReport,
  RepositoryOverview,
} from "./domain/overview";
import { oidSchema, rootSchema } from "./domain/repository";
import type { RepositoryRoot } from "./domain/repository";
import { createOverviewStore, repositoryWarnings } from "./overview";
import type { OverviewDeps } from "./overview";

const a = "a".repeat(40);
const b = "b".repeat(40);
const c = "c".repeat(40);
const root = (path: string) => rootSchema.parse(path);
const ref = (name: string) => branchRefSchema.parse(`refs/heads/${name}`);

function behind(name: string, target: string, dirty: string | null = null) {
  return {
    reference: `refs/heads/${name}`,
    name,
    oid: a,
    role: name === "main" ? "default" : "other",
    checkedOutAt: null,
    state: {
      kind: "behind",
      upstream: `refs/remotes/origin/${name}`,
      target,
      behind: 1,
      blocker: dirty === null ? null : { kind: "dirty", worktree: dirty },
    },
  };
}

function upToDate(name: string) {
  return {
    reference: `refs/heads/${name}`,
    name,
    oid: a,
    role: name === "main" ? "default" : "other",
    checkedOutAt: null,
    state: { kind: "upToDate", upstream: `refs/remotes/origin/${name}` },
  };
}

function overview(
  path: string,
  commonDir: string,
  branches: unknown[],
  fetch: { changed: boolean; failed?: boolean } | null = null,
): RepositoryOverview {
  return overviewSchema.parse({
    root: path,
    commonDir,
    name: path.split("/").at(-1),
    branches,
    fetch:
      fetch === null
        ? null
        : {
            at: 1_780_000_000,
            changed: fetch.changed,
            coalesced: false,
            remotes: [
              {
                remote: "origin",
                outcome: fetch.failed
                  ? {
                      kind: "failed",
                      failure: "network",
                      message: "Could not resolve host",
                    }
                  : { kind: "fetched" },
              },
            ],
          },
    observedAt: 1_780_000_000,
  });
}

type Call = {
  label: string;
  resolve: (value: RepositoryOverview | FastForwardReport) => void;
  reject: (error: unknown) => void;
};

function harness() {
  const pending: Call[] = [];
  const calls: string[] = [];
  const advances: Advance[][] = [];
  const timers: { ms: number; run: () => void; stopped: boolean }[] = [];
  let visible = true;
  let visibilityListener = () => {};
  let clock = 0;
  const push = <T>(label: string) =>
    new Promise<T>((resolve, reject) => {
      calls.push(label);
      pending.push({
        label,
        resolve: resolve as Call["resolve"],
        reject,
      });
    });
  const deps: OverviewDeps = {
    overview: (path, mode) => push(`${mode} ${path}`),
    fastForward: (path, sent) => {
      advances.push(sent);
      return push(`fastForward ${path}`);
    },
    now: () => clock,
    every(run, ms) {
      const timer = { ms, run, stopped: false };
      timers.push(timer);
      return () => {
        timer.stopped = true;
      };
    },
    visible: () => visible,
    onVisibilityChange(run) {
      visibilityListener = run;
      return () => {};
    },
  };
  const store = createOverviewStore(deps);
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    store,
    calls,
    advances,
    timers,
    pendingLabels: () => pending.map(({ label }) => label),
    setClock(value: number) {
      clock = value;
    },
    setVisible(value: boolean) {
      visible = value;
      visibilityListener();
    },
    async answer(
      respond: (label: string) => RepositoryOverview | FastForwardReport,
    ) {
      while (pending.length > 0) {
        for (const call of pending.splice(0)) call.resolve(respond(call.label));
        await flush();
      }
    },
    async answerOne(value: RepositoryOverview | FastForwardReport) {
      const call = pending.shift();
      if (!call) throw new Error("No call is pending.");
      call.resolve(value);
      await flush();
    },
    async failOne(error: unknown) {
      const call = pending.shift();
      if (!call) throw new Error("No call is pending.");
      call.reject(error);
      await flush();
    },
  };
}

const app = root("/code/app");
const appWorktree = root("/code/app-develop");
const api = root("/code/api");

describe("overview store", () => {
  it("reads and fetches each repository once when tracked twice", async () => {
    const h = harness();
    h.store.track([app, api]);
    h.store.track([app, api]);
    await h.answer((label) =>
      label.endsWith(app)
        ? overview(app, "/code/app/.git", [upToDate("main")])
        : overview(api, "/code/api/.git", [upToDate("main")]),
    );
    expect(h.calls).toEqual([
      "local /code/app",
      "local /code/api",
      "remote /code/app",
      "remote /code/api",
    ]);
  });

  it("fetches two saved worktrees of one repository once", async () => {
    const h = harness();
    h.store.track([app, appWorktree]);
    await h.answer((label) =>
      overview(label.split(" ")[1]!, "/code/app/.git", [upToDate("main")]),
    );
    expect(h.calls).toEqual([
      "local /code/app",
      "local /code/app-develop",
      "remote /code/app",
    ]);
    expect(
      h.store.getSnapshot().repositories.map(({ commonDir, roots }) => ({
        commonDir,
        roots,
      })),
    ).toEqual([{ commonDir: "/code/app/.git", roots: [app, appWorktree] }]);
  });

  it("joins a running fetch and merges fast-forwards queued behind it", async () => {
    const h = harness();
    const dir = root("/code/app/.git");
    const local = overview(app, dir, [behind("main", b), behind("feat", c)]);
    h.store.track([app]);
    await h.answerOne(local);
    expect(h.pendingLabels()).toEqual(["remote /code/app"]);
    void h.store.fetch();
    void h.store.fetch(dir);
    void h.store.fastForward(dir, ref("main"));
    void h.store.fastForward(dir, ref("feat"));
    expect(h.pendingLabels()).toEqual(["remote /code/app"]);
    await h.answerOne(overview(app, dir, local.branches, { changed: false }));
    expect(h.calls).toEqual([
      "local /code/app",
      "remote /code/app",
      "fastForward /code/app",
    ]);
    expect(h.advances).toEqual([
      [
        { reference: "refs/heads/main", from: a, to: b },
        { reference: "refs/heads/feat", from: a, to: c },
      ],
    ]);
  });

  it("waits while hidden and catches up once visible", async () => {
    const h = harness();
    h.store.setInterval(15);
    h.store.track([app]);
    await h.answer(() =>
      overview(app, "/code/app/.git", [upToDate("main")], {
        changed: false,
      }),
    );
    expect(h.timers.map(({ ms }) => ms)).toEqual([900_000]);
    h.setVisible(false);
    h.timers[0]!.run();
    h.timers[0]!.run();
    expect(h.pendingLabels()).toEqual([]);
    h.setVisible(true);
    expect(h.pendingLabels()).toEqual(["remote /code/app"]);
    await h.answer(() =>
      overview(app, "/code/app/.git", [upToDate("main")], { changed: false }),
    );
    h.setVisible(true);
    expect(h.pendingLabels()).toEqual([]);
    h.timers[0]!.run();
    expect(h.pendingLabels()).toEqual(["remote /code/app"]);
  });

  it("installs no timer when the interval is off", () => {
    const h = harness();
    h.store.setInterval(0);
    expect(h.timers).toEqual([]);
    h.store.setInterval(5);
    h.store.setInterval(5);
    h.store.setInterval(0);
    expect(h.timers.map(({ ms, stopped }) => ({ ms, stopped }))).toEqual([
      { ms: 300_000, stopped: true },
    ]);
  });

  it("reports moved refs only after a changing fetch or an advanced branch", async () => {
    const h = harness();
    const dir = root("/code/app/.git");
    const changes: RepositoryRoot[][] = [];
    h.store.onRefsChanged((roots) => changes.push(roots));
    h.store.track([app, appWorktree]);
    await h.answer((label) =>
      label.startsWith("local")
        ? overview(label.split(" ")[1]!, dir, [behind("main", b)])
        : overview(app, dir, [behind("main", b)], { changed: false }),
    );
    expect(changes).toEqual([]);
    void h.store.fetch();
    await h.answerOne(
      overview(app, dir, [behind("main", c)], { changed: true }),
    );
    expect(changes).toEqual([[app, appWorktree]]);
    void h.store.fastForward(dir, ref("main"));
    await h.answerOne(
      fastForwardReportSchema.parse({
        outcomes: [
          {
            kind: "skipped",
            reference: "refs/heads/main",
            reason: { kind: "changed" },
          },
        ],
        overview: overview(app, dir, [behind("main", c)]),
      }),
    );
    expect(changes).toEqual([[app, appWorktree]]);
    void h.store.fastForward(dir, ref("main"));
    await h.answerOne(
      fastForwardReportSchema.parse({
        outcomes: [
          { kind: "advanced", reference: "refs/heads/main", from: a, to: c },
        ],
        overview: overview(app, dir, [upToDate("main")]),
      }),
    );
    expect(changes).toEqual([
      [app, appWorktree],
      [app, appWorktree],
    ]);
    expect(h.advances).toEqual([
      [{ reference: "refs/heads/main", from: a, to: c }],
      [{ reference: "refs/heads/main", from: a, to: c }],
    ]);
  });

  it("rereads local status after a write moves a ref and reports the move", async () => {
    const h = harness();
    const dir = root("/code/app/.git");
    const changes: RepositoryRoot[][] = [];
    h.store.onRefsChanged((roots) => changes.push(roots));
    h.store.track([app, appWorktree]);
    await h.answer((label) =>
      label.startsWith("local")
        ? overview(label.split(" ")[1]!, dir, [upToDate("main")])
        : overview(app, dir, [upToDate("main")], { changed: false }),
    );
    h.calls.length = 0;
    const refreshed = h.store.refreshLocal(dir);
    expect(h.calls).toEqual([`local ${app}`]);
    await h.answerOne(overview(app, dir, [behind("main", b)]));
    await refreshed;
    expect(changes).toEqual([[app, appWorktree]]);
    expect(
      h.store.getSnapshot().repositories[0]?.overview.branches[0]?.state.kind,
    ).toBe("behind");
    const failed = h.store.refreshLocal(dir);
    await h.failOne(new Error("gone"));
    await failed;
    expect(changes).toEqual([
      [app, appWorktree],
      [app, appWorktree],
    ]);
  });

  it("updates all with exactly the ready pairs of each repository", async () => {
    const h = harness();
    h.store.track([app, api]);
    await h.answer((label) => {
      const [mode, path] = label.split(" ");
      const branches =
        path === app
          ? [behind("main", b), behind("develop", c, "/code/app-develop")]
          : [behind("main", c), behind("feat", b), upToDate("old")];
      return overview(
        path!,
        `${path}/.git`,
        branches,
        mode === "remote" ? { changed: false } : null,
      );
    });
    void h.store.updateAll();
    expect(h.pendingLabels()).toEqual([
      "fastForward /code/app",
      "fastForward /code/api",
    ]);
    expect(h.advances).toEqual([
      [{ reference: "refs/heads/main", from: a, to: b }],
      [
        { reference: "refs/heads/main", from: a, to: c },
        { reference: "refs/heads/feat", from: a, to: b },
      ],
    ]);
  });

  it("updates one repository's ready pairs when scoped to it", async () => {
    const h = harness();
    h.store.track([app, api]);
    await h.answer((label) => {
      const [mode, path] = label.split(" ");
      return overview(
        path!,
        `${path}/.git`,
        [behind("main", path === app ? b : c)],
        mode === "remote" ? { changed: false } : null,
      );
    });
    void h.store.updateAll(root("/code/api/.git"));
    expect(h.pendingLabels()).toEqual(["fastForward /code/api"]);
    expect(h.advances).toEqual([
      [{ reference: "refs/heads/main", from: a, to: c }],
    ]);
  });

  it("sorts repositories by attention, then by name", async () => {
    const h = harness();
    const repos = {
      "/code/zeta": [behind("main", b)],
      "/code/beta": [upToDate("main")],
      "/code/alpha": [upToDate("main"), behind("feat", b)],
      "/code/gamma": [upToDate("main")],
      "/code/delta": [upToDate("main")],
    } as Record<string, unknown[]>;
    h.store.track(Object.keys(repos).map(root));
    h.setClock(60_000);
    await h.answer((label) => {
      const [mode, path] = label.split(" ");
      return overview(
        path!,
        `${path}/.git`,
        repos[path!]!,
        mode === "remote"
          ? { changed: false, failed: path === "/code/gamma" }
          : null,
      );
    });
    const view = h.store.getSnapshot();
    expect(view.repositories.map(({ overview }) => overview.name)).toEqual([
      "zeta",
      "gamma",
      "alpha",
      "beta",
      "delta",
    ]);
  });

  it("reports each worktree's checked-out branch and every tracking branch", async () => {
    const dir = "/code/app/.git";
    const branches = [
      {
        ...behind("main", b),
        checkedOutAt: app,
        state: { ...behind("main", b).state, behind: 2 },
      },
      {
        ...upToDate("feature"),
        checkedOutAt: appWorktree,
        state: {
          kind: "diverged",
          upstream: "refs/remotes/origin/feature",
          ahead: 1,
          behind: 3,
        },
      },
      { ...upToDate("scratch"), state: { kind: "untracked" } },
    ];
    const h = harness();
    h.store.track([app, appWorktree]);
    await h.answer((label) => overview(label.split(" ")[1]!, dir, branches));
    const main = {
      upstream: "refs/remotes/origin/main",
      ahead: 0,
      behind: 2,
    };
    const feature = {
      upstream: "refs/remotes/origin/feature",
      ahead: 1,
      behind: 3,
    };
    const tracking = new Map([
      ["refs/heads/main", main],
      ["refs/heads/feature", feature],
    ]);
    expect(h.store.getSnapshot().syncByRoot).toEqual(
      new Map([
        [app, { head: { name: "main", divergence: main }, branches: tracking }],
        [
          appWorktree,
          {
            head: { name: "feature", divergence: feature },
            branches: tracking,
          },
        ],
      ]),
    );
  });

  it("keeps an unreadable root visible and retries it on Fetch", async () => {
    const h = harness();
    h.store.track([app]);
    await h.failOne({
      kind: "missingPath",
      message: "This folder no longer exists.",
    });
    expect(h.store.getSnapshot().roots.get(app)).toEqual({
      kind: "unavailable",
      problem: {
        kind: "missingPath",
        message: "This folder no longer exists.",
      },
    });
    void h.store.fetch();
    expect(h.pendingLabels()).toEqual(["local /code/app"]);
  });
});

describe("repository warnings", () => {
  it("describes fetch failures and skipped fast-forwards", () => {
    expect(
      repositoryWarnings({
        fetch: {
          kind: "fetched",
          at: 0,
          remotes: [
            { remote: "origin", outcome: { kind: "fetched" } },
            {
              remote: "archive",
              outcome: {
                kind: "failed",
                failure: "network",
                message: "Could not resolve host.",
              },
            },
          ],
        },
        outcomes: new Map([
          [
            ref("main"),
            {
              kind: "advanced",
              reference: ref("main"),
              from: oidSchema.parse(a),
              to: oidSchema.parse(b),
            },
          ],
          [
            ref("develop"),
            {
              kind: "skipped",
              reference: ref("develop"),
              reason: { kind: "dirty", worktree: root("/code/app-develop") },
            },
          ],
        ]),
      }),
    ).toEqual([
      "archive: Network error. Could not resolve host.",
      "Did not fast-forward develop. Uncommitted changes in app-develop. Commit or stash first.",
    ]);
  });

  it("reports a fetch that failed outright", () => {
    expect(
      repositoryWarnings({
        fetch: {
          kind: "failed",
          at: 0,
          problem: { kind: "gitFailed", message: "Git exited with status 1." },
        },
        outcomes: new Map(),
      }),
    ).toEqual(["Could not fetch. Git exited with status 1."]);
  });
});
