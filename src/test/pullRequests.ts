import { pullRequestSchema } from "../domain/pullRequest";
import type { PullRequest, PullRequestSummary } from "../domain/pullRequest";
import { get, mountApp } from "./appHarness";
import type { Harness } from "./appHarness";
import { pullKey, pullsKey } from "./fakeBridge";
import type { Bridge, World } from "./fakeBridge";
import { OTHER, PIN } from "./fixtures";

export const at = (hour: number) =>
  `2026-11-02T${String(hour).padStart(2, "0")}:00:00Z`;
export const page = <T>(items: T[], total = items.length) => ({ items, total });

export function row(number: number, fields: Partial<PullRequestSummary> = {}) {
  return {
    number,
    title: `Row ${number}`,
    state: { kind: "open" as const, draft: false },
    author: "maja",
    viewerIsAuthor: false,
    head: `branch-${number}`,
    base: "main",
    labels: page([]),
    comments: 0,
    reviewRequested: false,
    review: null,
    checks: { passed: 0, failed: 0, skipped: 0, running: 0 },
    mergeable: "mergeable" as const,
    additions: 1,
    deletions: 1,
    createdAt: at(0),
    updatedAt: `2026-11-02T00:00:${60 - number}Z`,
    ...fields,
  };
}

export function pull(
  number: number,
  fields: Partial<PullRequest> = {},
): PullRequest {
  const { head: branch, checks: _, ...summary } = row(number);
  return pullRequestSchema.parse({
    ...summary,
    body: "Reads **once**.",
    baseOid: "b".repeat(40),
    changedFiles: 2,
    head: {
      branch,
      oid: "1".repeat(40),
      repository: { owner: "octo", repo: "pin" },
      crossRepository: false,
      maintainerCanModify: false,
    },
    reviewers: [],
    checks: page([]),
    commits: page([
      { oid: "a".repeat(40), headline: "Read it", by: "maja", at: at(1) },
    ]),
    timeline: page([
      {
        id: "C1",
        kind: "commit",
        oid: "a".repeat(40),
        headline: "Read it",
        by: "maja",
        at: at(1),
      },
      { id: "K1", kind: "comment", body: "Why?", by: "sara", at: at(2) },
    ]),
    threads: page([]),
    mergeState: "clean",
    ...fields,
  });
}

function world(world: World) {
  for (const [root, repo] of [
    [PIN, "pin"],
    [OTHER, "other"],
  ] as const)
    world.overviews.set(root, {
      ...world.overviews.get(root)!,
      github: { owner: "octo", repo },
    });
  const { pulls, details } = world.host;
  pulls.set(pullsKey("octo/pin", "open"), page([row(1), row(2), row(5)]));
  pulls.set(pullsKey("octo/other", "open"), page([row(3)]));
  pulls.set(pullsKey("octo/pin", "recentlyMerged"), page([]));
  pulls.set(pullsKey("octo/other", "recentlyMerged"), page([]));
  details.set(pullKey("octo/pin", 1), pull(1));
  details.set(pullKey("octo/pin", 2), pull(2, { body: "" }));
  world.host.status = {
    ...world.host.status,
    github: {
      kind: "connected",
      login: "octo",
      api: "https://api.github.com/",
      method: "gh",
      access: "private",
      connectedAt: 1,
    },
  };
}

export async function visit(
  more: {
    world?: (world: World) => void;
    bridge?: (bridge: Bridge) => void;
    stored?: Record<string, string>;
  } = {},
) {
  const app = await mountApp({
    ...more,
    world: (each) => {
      world(each);
      more.world?.(each);
    },
  });
  await app.click(get("button", /^Pull requests/));
  return app;
}

export const link = (number: number) =>
  get("link", new RegExp(`^Row ${number},`));
export async function open(app: Harness, number: number) {
  await app.click(link(number));
}

export const tab = (name: string) => get("tab", new RegExp(`^${name}`));
export const refresh = () => get("button", "Refresh pull requests");
