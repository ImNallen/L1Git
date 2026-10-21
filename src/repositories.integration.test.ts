import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmodSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  fastForwardReportSchema,
  overviewSchema,
  readyAdvances,
} from "./domain/overview";
import type { RepositoryOverview } from "./domain/overview";
import {
  detailSchema,
  filePatchSchema,
  lineStatsSchema,
  refsSchema,
  repositoryErrorSchema,
  snapshotSchema,
} from "./domain/repository";

const fixtureSchema = z.object({
  root: z.string(),
  repository: z.string(),
  remote: z.string(),
  unborn: z.string(),
  detached: z.string(),
  sync: z.object({
    repository: z.string(),
    remote: z.string(),
    colleague: z.string(),
    dirty: z.string(),
  }),
});
let fixture: z.infer<typeof fixtureSchema>;
let bridge: ChildProcess;
let endpoint: string;
const origin = "http://127.0.0.1:1422";
const answer = <T extends z.ZodType>(op: string, data: T) =>
  z.object({ ok: z.literal(true), op: z.literal(op), data });
const rejected = async (body: unknown) => {
  const response = await post(body);
  return {
    status: response.status,
    error: z.object({ error: z.string() }).parse(await response.json()).error,
  };
};
const snapshotEnvelope = answer("snapshot", snapshotSchema);
const refsEnvelope = answer("refs", refsSchema.strict());
const overviewEnvelope = answer("overview", overviewSchema);
const fastForwardEnvelope = answer("fastForward", fastForwardReportSchema);

async function post(
  body: unknown,
  requestOrigin: string | null = origin,
  route = "/api/run",
) {
  return fetch(`${endpoint}${route}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(requestOrigin === null ? {} : { Origin: requestOrigin }),
    },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  fixture = fixtureSchema.parse(
    JSON.parse(
      execFileSync(process.execPath, ["scripts/create-fixture.mjs"], {
        encoding: "utf8",
      }),
    ),
  );
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("No bridge port available");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  endpoint = `http://127.0.0.1:${port}`;
  bridge = spawn("./target/debug/l1-git-dev-bridge", [], {
    env: {
      ...process.env,
      L1GIT_BRIDGE_PORT: String(port),
      L1GIT_DEV_PORT: "1422",
    },
    stdio: "ignore",
  });
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      await post({ op: "snapshot", path: fixture.unborn });
      return;
    } catch {
      await setTimeout(50);
    }
  }
  throw new Error("The real development bridge did not start");
}, 20_000);

afterAll(async () => {
  if (bridge && bridge.exitCode === null) {
    bridge.kill();
    await once(bridge, "exit");
  }
  if (fixture) rmSync(fixture.root, { recursive: true, force: true });
});

describe("real Rust transport contract", () => {
  it("parses a real repository with every branch's history and reads first-parent merge details", async () => {
    const response = await post({ op: "snapshot", path: fixture.repository });
    const snapshot = snapshotEnvelope.parse(await response.json()).data;
    expect(snapshot.name).toBe("l1-demo");
    expect(snapshot.head.kind).toBe("attached");
    expect(
      snapshot.branches.filter((branch) => branch.kind === "local"),
    ).toHaveLength(3);
    expect(
      snapshot.branches.filter((branch) => branch.kind === "remote"),
    ).toHaveLength(3);
    expect(
      snapshot.branches.some((branch) => branch.name === "origin/HEAD"),
    ).toBe(false);
    const theme = snapshot.commits.find(
      (commit) => commit.subject === "feat(theme): add the L1 dark canvas",
    );
    expect(snapshot.tags).toEqual([
      { reference: "refs/tags/v0.1.0", name: "v0.1.0", oid: theme?.oid },
    ]);
    const squashed = snapshot.branches.find(
      (branch) => branch.reference === "refs/heads/feat/squashed",
    );
    const squash = snapshot.commits.find(
      (commit) => commit.subject === "feat(search): search loaded history (#2)",
    );
    expect(snapshot.squashes).toEqual([
      { tip: squashed?.oid, commit: squash?.oid },
    ]);
    expect(
      snapshot.worktrees.map(({ name, head, current }) => [
        name,
        head.kind,
        current,
      ]),
    ).toEqual([
      ["l1-demo", "attached", true],
      ["detached-worktree", "detached", false],
    ]);
    expect(
      snapshot.remotes.find((remote) => remote.name === "github")?.github,
    ).toEqual({ owner: "l1-family", repo: "l1-git" });
    const remoteTip = snapshot.branches.find(
      (branch) =>
        branch.reference === "refs/remotes/origin/feat/remote-inspector",
    );
    const inspector = snapshot.commits.find(
      (commit) => commit.oid === remoteTip?.oid,
    );
    expect(inspector?.subject).toBe(
      "feat(inspector): show commit message and changed paths",
    );
    if (!inspector) throw new Error("Fixture remote commit is missing");
    const inspectorDetail = answer("commitDetail", detailSchema).parse(
      await (
        await post({
          op: "commitDetail",
          path: fixture.repository,
          oid: inspector.oid,
        })
      ).json(),
    ).data;
    expect(inspectorDetail.files).toEqual([
      { path: "assets/icon.png", status: "A" },
      { path: "graph.ts", status: "D" },
      { path: "history.ts", status: "M" },
      { path: "inspector.ts", status: "A" },
      { path: "src/inspector/files/tree.ts", status: "A" },
      { path: "src/inspector/panel.ts", status: "A" },
    ]);
    const merge = snapshot.commits.find(
      (commit) => commit.parents.length === 2,
    );
    expect(merge?.subject).toBe("Merge branch feat/history");
    if (!merge) throw new Error("Fixture merge is missing");
    const detail = answer("commitDetail", detailSchema).parse(
      await (
        await post({
          op: "commitDetail",
          path: fixture.repository,
          oid: merge.oid,
        })
      ).json(),
    ).data;
    expect(detail.diffBase).toBe("firstParent");
    expect(detail.files.map((file) => file.path)).toEqual([
      "graph.ts",
      "history.ts",
    ]);
  });

  it("reads text, binary, and root file patches and rejects unchanged paths", async () => {
    const { branches, commits } = snapshotEnvelope.parse(
      await (await post({ op: "snapshot", path: fixture.repository })).json(),
    ).data;
    const remoteTip = branches.find(
      (branch) =>
        branch.reference === "refs/remotes/origin/feat/remote-inspector",
    );
    const inspector = commits.find((commit) => commit.oid === remoteTip?.oid);
    const root = commits.find((commit) => commit.parents.length === 0);
    if (!inspector || !root) throw new Error("Fixture commits are missing");
    const patch = async (oid: string, file: string) =>
      (
        await post({ op: "filePatch", path: fixture.repository, oid, file })
      ).json();
    const success = answer("filePatch", filePatchSchema);
    expect(
      success.parse(await patch(inspector.oid, "history.ts")).data,
    ).toEqual({
      kind: "text",
      lossy: false,
      patch: [
        "diff --git a/history.ts b/history.ts",
        "index 86fb985..ee9ebd3 100644",
        "--- a/history.ts",
        "+++ b/history.ts",
        "@@ -1,3 +1,3 @@",
        " export const historyLimit = 200;",
        '-export const historyOrder = "topological";',
        '+export const historyOrder = "first parent";',
        " export const historyIncludesRemotes = true;",
        "",
      ].join("\n"),
    });
    expect(
      success.parse(await patch(inspector.oid, "assets/icon.png")).data,
    ).toEqual({ kind: "binary" });
    expect(success.parse(await patch(root.oid, "README.md")).data).toEqual({
      kind: "text",
      lossy: false,
      patch: [
        "diff --git a/README.md b/README.md",
        "new file mode 100644",
        "index 0000000..a82fc92",
        "--- /dev/null",
        "+++ b/README.md",
        "@@ -0,0 +1 @@",
        "+# L1 demo",
        "",
      ].join("\n"),
    });
    const failure = z.object({
      ok: z.literal(false),
      error: repositoryErrorSchema,
    });
    for (const file of ["README.md", "src", ":(glob)*"])
      expect(failure.parse(await patch(inspector.oid, file)).error.kind).toBe(
        "unchangedPath",
      );
  });

  it("counts root, merge, and binary changes against the inspector's diff base", async () => {
    const { commits } = snapshotEnvelope.parse(
      await (await post({ op: "snapshot", path: fixture.repository })).json(),
    ).data;
    const oid = (subject: string) =>
      commits.find((commit) => commit.subject === subject)?.oid;
    const requested = [
      oid("docs: start the local Git fixture"),
      oid("Merge branch feat/history"),
      oid("feat(inspector): show commit message and changed paths"),
    ];
    const response = await post({
      op: "lineStats",
      path: fixture.repository,
      oids: requested,
    });
    expect(
      answer("lineStats", lineStatsSchema).parse(await response.json()).data,
    ).toEqual([
      { oid: requested[0], added: 1, deleted: 0 },
      { oid: requested[1], added: 4, deleted: 0 },
      { oid: requested[2], added: 4, deleted: 2 },
    ]);
  });

  it("reads the same root, name, HEAD, and branches as the snapshot without history", async () => {
    for (const path of [fixture.repository, fixture.unborn, fixture.detached]) {
      const snapshot = snapshotEnvelope.parse(
        await (await post({ op: "snapshot", path })).json(),
      ).data;
      const refs = refsEnvelope.parse(
        await (await post({ op: "refs", path })).json(),
      ).data;
      expect(refs).toEqual({
        root: snapshot.root,
        name: snapshot.name,
        head: snapshot.head,
        branches: snapshot.branches,
      });
    }
    const refs = refsEnvelope.parse(
      await (await post({ op: "refs", path: fixture.repository })).json(),
    ).data;
    expect(refs.name).toBe("l1-demo");
    expect(refs.branches.map((branch) => branch.reference)).toEqual([
      "refs/heads/feat/history",
      "refs/heads/feat/squashed",
      "refs/heads/main",
      "refs/remotes/origin/feat/history",
      "refs/remotes/origin/feat/remote-inspector",
      "refs/remotes/origin/main",
    ]);
    expect(
      z
        .object({ ok: z.literal(false), error: repositoryErrorSchema })
        .parse(await (await post({ op: "refs", path: fixture.remote })).json())
        .error.kind,
    ).toBe("bareRepository");
  });

  it("reports empty, detached, bare, and missing states through the same contract", async () => {
    const unborn = snapshotEnvelope.parse(
      await (await post({ op: "snapshot", path: fixture.unborn })).json(),
    ).data;
    expect(unborn.head).toEqual({
      kind: "unborn",
      reference: "refs/heads/main",
    });
    expect(unborn.commits).toEqual([]);
    const detached = snapshotEnvelope.parse(
      await (await post({ op: "snapshot", path: fixture.detached })).json(),
    ).data;
    expect(detached.head.kind).toBe("detached");
    expect(detached.root).not.toBe(unborn.root);
    const failure = z.object({
      ok: z.literal(false),
      error: repositoryErrorSchema,
    });
    expect(
      failure.parse(
        await (await post({ op: "snapshot", path: fixture.remote })).json(),
      ).error.kind,
    ).toBe("bareRepository");
    expect(
      failure.parse(
        await (
          await post({ op: "snapshot", path: `${fixture.root}/missing` })
        ).json(),
      ).error.kind,
    ).toBe("missingPath");
  });

  it("rejects other origins, absent origins, unknown operations, and malformed requests", async () => {
    for (const operation of ["snapshot", "refs"])
      for (const requestOrigin of [
        null,
        "https://example.test",
        "http://127.0.0.1:9999",
      ]) {
        const response = await post(
          { op: operation, path: fixture.repository },
          requestOrigin,
        );
        expect(response.status).toBe(403);
        expect(response.headers.get("access-control-allow-origin")).toBeNull();
      }
    expect(
      await rejected({ op: "notAnOperation", path: fixture.repository }),
    ).toEqual({
      status: 400,
      error:
        "unknown variant `notAnOperation`, expected one of `snapshot`, `refs`, `commitDetail`, `lineStats`, `filePatch`, `overview`, `fastForward` at line 1 column 22",
    });
    expect(
      await rejected({ op: "commitDetail", path: fixture.repository }),
    ).toEqual({ status: 400, error: "missing field `oid`" });
    expect(
      (await post({ path: fixture.repository }, origin, "/api/snapshot"))
        .status,
    ).toBe(404);
    expect(
      await rejected({ op: "snapshot", path: fixture.repository, extra: 1 }),
    ).toEqual({ status: 400, error: "unknown field `extra`, expected `path`" });
    expect(
      await rejected({
        op: "refs",
        path: fixture.repository,
        unexpected: true,
      }),
    ).toEqual({
      status: 400,
      error: "unknown field `unexpected`, expected `path`",
    });
  });
});

describe("real Rust fetch and fast-forward contract", () => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  const git = (path: string, ...args: string[]) =>
    execFileSync("git", ["-C", path, ...args], {
      encoding: "utf8",
      env,
    }).trim();
  const state = (overview: RepositoryOverview, name: string) =>
    overview.branches.find((branch) => branch.name === name)?.state;

  it("reads local refs, fetches, fast-forwards only the ready branch, and skips the rest", async () => {
    const { sync } = fixture;
    const repository = realpathSync(sync.repository);
    const dirty = realpathSync(sync.dirty);
    const main = git(repository, "rev-parse", "main");
    const develop = git(repository, "rev-parse", "develop");
    const diverged = git(repository, "rev-parse", "feat/diverged");
    const theirs = (branch: string) =>
      git(sync.colleague, "rev-parse", `origin/${branch}`);

    const local = overviewEnvelope.parse(
      await (
        await post({ op: "overview", path: sync.repository, mode: "local" })
      ).json(),
    ).data;
    expect(local.root).toBe(repository);
    expect(local.commonDir).toBe(join(repository, ".git"));
    expect(local.name).toBe("sync-demo");
    expect(local.fetch).toBeNull();
    expect(
      local.branches.map(({ name, role, checkedOutAt, state }) => ({
        name,
        role,
        checkedOutAt,
        state,
      })),
    ).toEqual([
      {
        name: "develop",
        role: "mainline",
        checkedOutAt: dirty,
        state: { kind: "upToDate", upstream: "refs/remotes/origin/develop" },
      },
      {
        name: "feat/diverged",
        role: "other",
        checkedOutAt: null,
        state: {
          kind: "ahead",
          upstream: "refs/remotes/origin/feat/diverged",
          ahead: 1,
        },
      },
      {
        name: "main",
        role: "default",
        checkedOutAt: repository,
        state: { kind: "upToDate", upstream: "refs/remotes/origin/main" },
      },
    ]);

    const fetched = overviewEnvelope.parse(
      await (
        await post({ op: "overview", path: sync.repository, mode: "remote" })
      ).json(),
    ).data;
    expect(fetched.fetch?.changed).toBe(true);
    expect(fetched.fetch?.coalesced).toBe(false);
    expect(fetched.fetch?.remotes).toEqual([
      { remote: "github", outcome: { kind: "skipped" } },
      { remote: "origin", outcome: { kind: "fetched" } },
    ]);
    expect(state(fetched, "main")).toEqual({
      kind: "behind",
      upstream: "refs/remotes/origin/main",
      target: theirs("main"),
      behind: 1,
      blocker: null,
    });
    expect(state(fetched, "develop")).toEqual({
      kind: "behind",
      upstream: "refs/remotes/origin/develop",
      target: theirs("develop"),
      behind: 1,
      blocker: { kind: "dirty", worktree: dirty },
    });
    expect(state(fetched, "feat/diverged")).toEqual({
      kind: "diverged",
      upstream: "refs/remotes/origin/feat/diverged",
      ahead: 1,
      behind: 1,
    });
    expect(readyAdvances(fetched)).toEqual([
      { reference: "refs/heads/main", from: main, to: theirs("main") },
    ]);

    const updated = fastForwardEnvelope.parse(
      await (
        await post({
          op: "fastForward",
          path: sync.repository,
          advances: [
            ...readyAdvances(fetched),
            {
              reference: "refs/heads/develop",
              from: develop,
              to: theirs("develop"),
            },
            {
              reference: "refs/heads/feat/diverged",
              from: diverged,
              to: theirs("feat/diverged"),
            },
          ],
        })
      ).json(),
    ).data;
    expect(updated.outcomes).toEqual([
      {
        kind: "advanced",
        reference: "refs/heads/main",
        from: main,
        to: theirs("main"),
      },
      {
        kind: "skipped",
        reference: "refs/heads/develop",
        reason: { kind: "dirty", worktree: dirty },
      },
      {
        kind: "skipped",
        reference: "refs/heads/feat/diverged",
        reason: { kind: "notBehind" },
      },
    ]);
    expect(state(updated.overview, "main")).toEqual({
      kind: "upToDate",
      upstream: "refs/remotes/origin/main",
    });
    expect(git(repository, "rev-parse", "HEAD")).toBe(theirs("main"));
    expect(git(repository, "status", "--porcelain")).toBe("");
    expect(git(repository, "rev-parse", "develop")).toBe(develop);
    expect(git(repository, "rev-parse", "feat/diverged")).toBe(diverged);
    expect(git(dirty, "status", "--porcelain")).toBe("M README.md");
  });

  it("fetches the reader fixture without contacting GitHub", async () => {
    const fetched = overviewEnvelope.parse(
      await (
        await post({ op: "overview", path: fixture.repository, mode: "remote" })
      ).json(),
    ).data;
    expect(fetched.fetch?.remotes).toEqual([
      { remote: "github", outcome: { kind: "skipped" } },
      { remote: "origin", outcome: { kind: "fetched" } },
    ]);
  });

  it("rejects other origins and unexpected fields on fetch and fast-forward", async () => {
    const cases = [
      {
        body: { op: "overview", path: fixture.sync.repository, mode: "local" },
        error: "unknown field `unexpected`, expected `path` or `mode`",
      },
      {
        body: {
          op: "fastForward",
          path: fixture.sync.repository,
          advances: [],
        },
        error: "unknown field `unexpected`, expected `path` or `advances`",
      },
    ];
    for (const { body, error } of cases) {
      const foreign = await post(body, "https://example.test");
      expect(foreign.status).toBe(403);
      expect(foreign.headers.get("access-control-allow-origin")).toBeNull();
      expect(await rejected({ ...body, unexpected: true })).toEqual({
        status: 400,
        error,
      });
    }
    expect(
      (
        await post({
          op: "fastForward",
          path: fixture.sync.repository,
          advances: [
            {
              reference: "refs/remotes/origin/main",
              from: "a".repeat(40),
              to: "b".repeat(40),
            },
          ],
        })
      ).status,
    ).toBe(400);
  });

  it("answers reads while another request waits on a slow fetch", async () => {
    const slow = join(fixture.root, "sync-slow");
    git(fixture.root, "clone", "--quiet", fixture.sync.remote, slow);
    const uploadPack = join(fixture.root, "slow-upload-pack");
    writeFileSync(
      uploadPack,
      '#!/bin/sh\nsleep 2\nexec git upload-pack "$@"\n',
    );
    chmodSync(uploadPack, 0o755);
    git(slow, "config", "remote.origin.uploadpack", uploadPack);

    const started = performance.now();
    const fetching = post({ op: "overview", path: slow, mode: "remote" }).then(
      async (response) => ({
        overview: overviewEnvelope.parse(await response.json()).data,
        finishedAt: performance.now(),
      }),
    );
    await setTimeout(200);
    const read = snapshotEnvelope.parse(
      await (await post({ op: "snapshot", path: fixture.repository })).json(),
    ).data;
    const readFinishedAt = performance.now();
    const fetched = await fetching;
    expect(read.name).toBe("l1-demo");
    expect(fetched.overview.fetch?.remotes).toEqual([
      { remote: "origin", outcome: { kind: "fetched" } },
    ]);
    expect(fetched.finishedAt - started).toBeGreaterThanOrEqual(2000);
    expect(fetched.finishedAt - readFinishedAt).toBeGreaterThan(500);
  });
});
