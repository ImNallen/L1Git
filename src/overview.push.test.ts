import { describe, expect, it } from "vitest";
import { createOverviewStore } from "./overview";
import type { OverviewDeps } from "./overview";
import { overviewSchema } from "./domain/overview";
import { pushIntentSchema } from "./domain/push";
import type { PushAvailability, PushReport } from "./domain/push";
import { rootSchema } from "./domain/repository";

const main = rootSchema.parse("/work/main");
const linked = rootSchema.parse("/work/linked");
const common = rootSchema.parse("/work/main/.git");
const intent = pushIntentSchema.parse({
  purpose: "upstream",
  branch: "refs/heads/linked",
  source: "a".repeat(40),
  remote: "origin",
  destination: "refs/heads/release",
  endpoint: "Local or unrecognized remote",
  tracksEndpoint: true,
  fingerprint: "b".repeat(40),
});
const ready: PushAvailability = { kind: "ready", intent };
const overview = overviewSchema.parse({
  root: main,
  commonDir: common,
  name: "main",
  github: null,
  branches: [],
  fetch: null,
});
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function harness(overrides: Partial<OverviewDeps> = {}) {
  const pushed: { path: string; intent: unknown }[] = [];
  const deps: OverviewDeps = {
    overview: async () => overview,
    fastForward: async () => ({ outcomes: [], overview }),
    preparePush: async () => ready,
    operationProbe: async () => ({ kind: "idle" }),
    push: async (path, intent) => {
      pushed.push({ path, intent });
      return {
        outcome: { kind: "pushed" },
        refresh: { kind: "refreshed", overview, availability: ready },
      };
    },
    now: () => 1,
    every: () => () => {},
    visible: () => true,
    onVisibilityChange: () => () => {},
    ...overrides,
  };
  return { store: createOverviewStore(deps), pushed };
}

describe("per-worktree push store", () => {
  it("queues the exact clicked worktree and intent behind another operation", async () => {
    const fetch = deferred<typeof overview>();
    let first = true;
    const h = harness({
      overview: async (_, mode) =>
        mode === "remote" && !first
          ? fetch.promise
          : ((first = false), overview),
    });
    h.store.track([main, linked]);
    await flush();
    const job = h.store.push(linked, intent);
    expect(h.pushed).toEqual([]);
    fetch.resolve(overview);
    expect((await job)?.outcome.kind).toBe("pushed");
    expect(h.pushed).toEqual([{ path: linked, intent }]);
  });

  it("preserves accepted publication and notifies refs after refresh failure", async () => {
    const h = harness({
      push: async () => ({
        outcome: { kind: "pushed" },
        refresh: { kind: "failed", message: "Local read failed." },
      }),
    });
    h.store.track([main, linked]);
    await flush();
    const refs: unknown[] = [];
    h.store.onRefsChanged((roots) => refs.push(roots));
    expect(await h.store.push(linked, intent)).toMatchObject({
      outcome: { kind: "pushed" },
      refreshProblem: "Local read failed.",
    });
    expect(h.store.getSnapshot().pushByRoot.get(linked)).toMatchObject({
      kind: "failed",
    });
    expect(refs).toEqual([[main, linked]]);
  });

  it("discards an older preparation response and immediately invalidates readiness", async () => {
    const old = deferred<PushAvailability>();
    const fresh = deferred<PushAvailability>();
    let count = 0;
    const h = harness({
      preparePush: () => (++count === 1 ? old.promise : fresh.promise),
    });
    h.store.track([main]);
    await flush();
    expect(h.store.getSnapshot().pushByRoot.get(main)?.kind).toBe("loading");
    const refresh = h.store.refreshLocal(common);
    await flush();
    fresh.resolve({ kind: "unavailable", reason: "detached" });
    await refresh;
    old.resolve(ready);
    await flush();
    expect(h.store.getSnapshot().pushByRoot.get(main)).toEqual({
      kind: "unavailable",
      reason: "detached",
    });
  });

  it("does not restore preparation or report a push for a removed root", async () => {
    const preparation = deferred<PushAvailability>();
    const result = deferred<PushReport>();
    const h = harness({
      preparePush: () => preparation.promise,
      push: () => result.promise,
    });
    h.store.track([main]);
    await flush();
    h.store.track([]);
    preparation.resolve(ready);
    await flush();
    expect(h.store.getSnapshot().pushByRoot.size).toBe(0);
    h.store.track([main]);
    await flush();
    const job = h.store.push(main, intent);
    h.store.track([]);
    result.resolve({
      outcome: { kind: "pushed" },
      refresh: { kind: "refreshed", overview, availability: ready },
    });
    expect(await job).toBeNull();
    expect(h.store.getSnapshot().pushByRoot.size).toBe(0);
    expect(h.store.getSnapshot().repositories).toEqual([]);
  });

  it("skips a removed queued worktree and keeps transport loss uncertain", async () => {
    const fetch = deferred<typeof overview>();
    const h = harness({
      overview: async (_, mode) =>
        mode === "remote" ? fetch.promise : overview,
      push: async () => {
        throw new Error("lost response");
      },
    });
    h.store.track([main, linked]);
    await flush();
    const removed = h.store.push(linked, intent);
    h.store.track([main]);
    fetch.resolve(overview);
    expect(await removed).toBeNull();
    expect(h.store.getSnapshot().pushByRoot.has(linked)).toBe(false);
    expect((await h.store.push(main, intent))?.outcome.kind).toBe("uncertain");
  });
});

it("keeps a newer preparation and reports the push when a refresh overlaps it", async () => {
  const result = deferred<PushReport>();
  const preparation = deferred<PushAvailability>();
  let refreshing = false;
  const h = harness({
    push: () => result.promise,
    preparePush: async () => (refreshing ? preparation.promise : ready),
  });
  h.store.track([main]);
  await flush();
  const job = h.store.push(main, intent);
  expect(h.store.getSnapshot().repositories[0]?.activity).toEqual({
    kind: "pushing",
    root: main,
  });
  refreshing = true;
  const refresh = h.store.refreshLocal(common);
  await flush();
  result.resolve({
    outcome: { kind: "pushed" },
    refresh: { kind: "refreshed", overview, availability: ready },
  });
  expect((await job)?.outcome.kind).toBe("pushed");
  expect(h.store.getSnapshot().pushByRoot.get(main)?.kind).toBe("loading");
  preparation.resolve({ kind: "unavailable", reason: "detached" });
  await refresh;
  expect(h.store.getSnapshot().pushByRoot.get(main)).toEqual({
    kind: "unavailable",
    reason: "detached",
  });
});

it("refreshes surviving worktrees when the clicked root is removed during push", async () => {
  const result = deferred<PushReport>();
  const h = harness({ push: () => result.promise });
  h.store.track([main, linked]);
  await flush();
  const changed: unknown[] = [];
  h.store.onRefsChanged((roots) => changed.push(roots));
  const job = h.store.push(linked, intent);
  h.store.track([main]);
  result.resolve({
    outcome: { kind: "pushed" },
    refresh: { kind: "refreshed", overview, availability: ready },
  });
  await job;
  expect(changed).toEqual([[main]]);
  expect(h.store.getSnapshot().pushByRoot.has(linked)).toBe(false);
  expect(h.store.getSnapshot().pushByRoot.get(main)?.kind).toBe("ready");
});

it("queues publication through the existing network job and preserves tracking and refresh failures", async () => {
  const publication = pushIntentSchema.parse({ ...intent, purpose: "publish" });
  const h = harness({
    push: async (path, clicked) => {
      expect(path).toBe(linked);
      expect(clicked).toEqual(publication);
      return {
        outcome: {
          kind: "published",
          tracking: { kind: "failed", message: "Config is locked." },
        },
        refresh: { kind: "failed", message: "Refresh failed." },
      };
    },
  });
  h.store.track([main, linked]);
  await flush();
  expect(await h.store.push(linked, publication)).toEqual({
    intent: publication,
    outcome: {
      kind: "published",
      tracking: { kind: "failed", message: "Config is locked." },
    },
    refreshProblem: "Refresh failed.",
  });
});
