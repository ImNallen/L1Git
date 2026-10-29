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
  branch: "refs/heads/linked",
  source: "a".repeat(40),
  remote: "origin",
  destination: "refs/heads/release",
  endpoint: "Local or unrecognized remote",
  fingerprint: "b".repeat(40),
});
const ready: PushAvailability = { kind: "ready", intent };
const overview = overviewSchema.parse({
  root: main,
  commonDir: common,
  name: "main",
  branches: [],
  fetch: null,
  observedAt: 1,
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
    await job;
    expect(h.pushed).toEqual([{ path: linked, intent }]);
    expect(
      h.store.getSnapshot().pushByRoot.get(linked)?.notice?.outcome.kind,
    ).toBe("pushed");
    expect(h.store.getSnapshot().pushByRoot.get(main)?.notice).toBeNull();
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
    await h.store.push(linked, intent);
    expect(h.store.getSnapshot().pushByRoot.get(linked)).toMatchObject({
      availability: { kind: "failed" },
      notice: {
        outcome: { kind: "pushed" },
        refreshProblem: "Local read failed.",
      },
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
    expect(h.store.getSnapshot().pushByRoot.get(main)?.availability.kind).toBe(
      "loading",
    );
    const refresh = h.store.refreshLocal(common);
    await flush();
    fresh.resolve({ kind: "unavailable", reason: "detached" });
    await refresh;
    old.resolve(ready);
    await flush();
    expect(h.store.getSnapshot().pushByRoot.get(main)?.availability).toEqual({
      kind: "unavailable",
      reason: "detached",
    });
  });

  it("does not restore preparation or notices for a removed root", async () => {
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
    await job;
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
    await removed;
    expect(h.store.getSnapshot().pushByRoot.has(linked)).toBe(false);
    await h.store.push(main, intent);
    expect(
      h.store.getSnapshot().pushByRoot.get(main)?.notice?.outcome.kind,
    ).toBe("uncertain");
  });
});

it("keeps a newer preparation and the publication notice when a refresh overlaps push", async () => {
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
  await job;
  expect(h.store.getSnapshot().pushByRoot.get(main)?.availability.kind).toBe(
    "loading",
  );
  preparation.resolve({ kind: "unavailable", reason: "detached" });
  await refresh;
  expect(h.store.getSnapshot().pushByRoot.get(main)).toMatchObject({
    availability: { kind: "unavailable", reason: "detached" },
    notice: { outcome: { kind: "pushed" } },
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
  expect(h.store.getSnapshot().pushByRoot.get(main)?.availability.kind).toBe(
    "ready",
  );
});
