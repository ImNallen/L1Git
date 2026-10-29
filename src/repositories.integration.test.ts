import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
  appliedSchema,
  branchMergedSchema,
  blameSchema,
  detailSchema,
  fileHistorySchema,
  filePatchSchema,
  lineStatsSchema,
  refsSchema,
  repositoryErrorSchema,
  snapshotSchema,
  undoHistorySchema,
  worktreePatchSchema,
  worktreeStatusSchema,
} from "./domain/repository";
import type { WorktreeStatus } from "./domain/repository";
import { pushAvailabilitySchema, pushReportSchema } from "./domain/push";
import { requestOps } from "./repositories";

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
const single = (oid: string) => ({
  base: { kind: "firstParent" },
  target: { kind: "commit", oid },
});
const between = (base: string, target: string) => ({
  base: { kind: "commit", oid: base },
  target: { kind: "commit", oid: target },
});
const indexAt = (repository: string, path: string, stage = "0") => {
  const entry = execFileSync(
    "git",
    ["-C", repository, "ls-files", "--stage", "--", path],
    { encoding: "utf8" },
  )
    .split("\n")
    .map((line) => line.split(/\s/))
    .find((fields) => fields[2] === stage);
  return entry ? { mode: entry[0], oid: entry[1] } : null;
};
const snapshotEnvelope = answer("snapshot", snapshotSchema);
const refsEnvelope = answer("refs", refsSchema.strict());
const overviewEnvelope = answer("overview", overviewSchema);
const fastForwardEnvelope = answer("fastForward", fastForwardReportSchema);
const worktreeStatusEnvelope = answer(
  "worktreeStatus",
  worktreeStatusSchema,
).strict();
const worktreePatchEnvelope = answer(
  "worktreePatch",
  worktreePatchSchema,
).strict();

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

async function startBridge(env: Record<string, string>) {
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
  const started = {
    endpoint: `http://127.0.0.1:${port}`,
    bridge: spawn("./target/debug/l1-git-dev-bridge", [], {
      env: {
        ...process.env,
        L1GIT_UNDO_DIR: join(fixture.root, "undo"),
        ...env,
        L1GIT_BRIDGE_PORT: String(port),
        L1GIT_DEV_PORT: "1422",
      },
      stdio: "ignore",
    }),
  };
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      await fetch(`${started.endpoint}/api/run`, { method: "POST" });
      return started;
    } catch {
      await setTimeout(50);
    }
  }
  throw new Error("The real development bridge did not start");
}

beforeAll(async () => {
  fixture = fixtureSchema.parse(
    JSON.parse(
      execFileSync(process.execPath, ["scripts/create-fixture.mjs"], {
        encoding: "utf8",
      }),
    ),
  );
  ({ bridge, endpoint } = await startBridge({}));
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
      {
        reference: "refs/tags/v0.1.0",
        name: "v0.1.0",
        oid: theme?.oid,
        object: expect.any(String),
        annotated: true,
      },
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
          comparison: single(inspector.oid),
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
          comparison: single(merge.oid),
        })
      ).json(),
    ).data;
    expect(detail.base).toEqual({ kind: "firstParent" });
    expect(detail.files.map((file) => file.path)).toEqual([
      "graph.ts",
      "history.ts",
    ]);
  });

  it("compares two commits and a commit with a dirty worktree", async () => {
    const { commits } = snapshotEnvelope.parse(
      await (await post({ op: "snapshot", path: fixture.repository })).json(),
    ).data;
    const root = commits.find((commit) => commit.parents.length === 0);
    const merge = commits.find((commit) => commit.parents.length === 2);
    if (!root || !merge) throw new Error("Fixture commits are missing");
    const detail = async (comparison: unknown, path = fixture.repository) =>
      answer("commitDetail", detailSchema).parse(
        await (await post({ op: "commitDetail", path, comparison })).json(),
      ).data;
    const forward = await detail(between(root.oid, merge.oid));
    expect(forward.base).toMatchObject({
      kind: "commit",
      commit: { oid: root.oid },
    });
    expect(forward.target).toMatchObject({
      kind: "commit",
      commit: { oid: merge.oid },
    });
    expect(forward.files).toEqual([
      { path: "graph.ts", status: "A" },
      { path: "history.ts", status: "A" },
      { path: "theme.css", status: "A" },
    ]);
    expect((await detail(between(merge.oid, root.oid))).files).toEqual([
      { path: "graph.ts", status: "D" },
      { path: "history.ts", status: "D" },
      { path: "theme.css", status: "D" },
    ]);
    expect((await detail(between(merge.oid, merge.oid))).files).toEqual([]);
    const patch = answer("filePatch", filePatchSchema).parse(
      await (
        await post({
          op: "filePatch",
          path: fixture.repository,
          comparison: between(merge.oid, root.oid),
          file: "graph.ts",
        })
      ).json(),
    ).data;
    expect(patch.kind === "text" && patch.patch).toContain("deleted file mode");

    const sync = snapshotEnvelope.parse(
      await (
        await post({ op: "snapshot", path: fixture.sync.repository })
      ).json(),
    ).data;
    const dirty = realpathSync(fixture.sync.dirty);
    const head = sync.worktrees.find(
      (worktree) => worktree.root === dirty,
    )?.head;
    if (head?.kind !== "attached") throw new Error("sync.dirty is missing");
    const working = await detail(
      {
        base: { kind: "commit", oid: head.oid },
        target: { kind: "worktree", root: dirty },
      },
      fixture.sync.repository,
    );
    expect(working.target).toMatchObject({ kind: "worktree", root: dirty });
    expect(working.files).toEqual([{ path: "README.md", status: "M" }]);
    expect(
      await rejected({
        op: "commitDetail",
        path: fixture.repository,
        comparison: { ...single(merge.oid), extra: 1 },
      }),
    ).toEqual({
      status: 400,
      error: expect.stringContaining("unknown field `extra`") as string,
    });
    expect(
      await rejected({
        op: "commitDetail",
        path: fixture.repository,
        comparison: {
          base: { kind: "firstParent", oid: root.oid },
          target: { kind: "commit", oid: merge.oid },
        },
      }),
    ).toEqual({
      status: 400,
      error: expect.stringContaining("unknown field `oid`") as string,
    });
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
        await post({
          op: "filePatch",
          path: fixture.repository,
          comparison: single(oid),
          file,
        })
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

  it("reads a file's history and blame, and notices for binary and deleted files", async () => {
    const { branches, commits } = snapshotEnvelope.parse(
      await (await post({ op: "snapshot", path: fixture.repository })).json(),
    ).data;
    const inspector = commits.find(
      (commit) =>
        commit.oid ===
        branches.find(
          (branch) =>
            branch.reference === "refs/remotes/origin/feat/remote-inspector",
        )?.oid,
    );
    const added = commits.find(
      (commit) =>
        commit.subject === "feat(history): add bounded repository history",
    );
    if (!inspector || !added) throw new Error("Fixture commits are missing");
    const read = async (op: "fileHistory" | "blame", file: string) =>
      (
        await post({ op, path: fixture.repository, oid: inspector.oid, file })
      ).json();
    expect(
      answer("fileHistory", fileHistorySchema)
        .parse(await read("fileHistory", "history.ts"))
        .data.map(({ commit, path }) => [commit.oid, path]),
    ).toEqual([
      [inspector.oid, "history.ts"],
      [added.oid, "history.ts"],
    ]);
    const blame = answer("blame", blameSchema).parse(
      await read("blame", "history.ts"),
    ).data;
    if (blame.kind !== "text") throw new Error("Expected text blame");
    expect(blame.contents).toBe(
      [
        "export const historyLimit = 200;",
        'export const historyOrder = "first parent";',
        "export const historyIncludesRemotes = true;",
        "",
      ].join("\n"),
    );
    expect(
      blame.ranges.map(({ oid, start, lines, author, summary }) => [
        oid,
        start,
        lines,
        author,
        summary,
      ]),
    ).toEqual([
      [added.oid, 1, 1, "N Allen", added.subject],
      [inspector.oid, 2, 1, "N Allen", inspector.subject],
      [added.oid, 3, 1, "N Allen", added.subject],
    ]);
    expect(
      answer("blame", blameSchema).parse(await read("blame", "assets/icon.png"))
        .data,
    ).toEqual({ kind: "binary" });
    const failure = z.object({
      ok: z.literal(false),
      error: repositoryErrorSchema,
    });
    expect(failure.parse(await read("blame", "graph.ts")).error.kind).toBe(
      "unsupportedPath",
    );
    expect(
      (
        await rejected({
          op: "blame",
          path: fixture.repository,
          oid: inspector.oid,
          file: "history.ts",
          comparison: single(inspector.oid),
        })
      ).status,
    ).toBe(400);
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

  it("reads the same refs as the snapshot without history", async () => {
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
        tags: snapshot.tags,
        stashes: snapshot.stashes,
        submodules: snapshot.submodules,
      });
    }
    const refs = refsEnvelope.parse(
      await (await post({ op: "refs", path: fixture.repository })).json(),
    ).data;
    expect(refs.name).toBe("l1-demo");
    const tagged = (revision: string) =>
      execFileSync("git", ["-C", fixture.repository, "rev-parse", revision], {
        encoding: "utf8",
      }).trim();
    expect(refs.tags).toEqual([
      {
        reference: "refs/tags/v0.1.0",
        name: "v0.1.0",
        oid: tagged("v0.1.0^{commit}"),
        object: tagged("refs/tags/v0.1.0"),
        annotated: true,
      },
    ]);
    expect(refs.tags[0]?.object).not.toBe(refs.tags[0]?.oid);
    expect(refs.stashes).toEqual([]);
    expect(refs.submodules).toEqual([]);
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

  it("lists a stash and a submodule, and details the stash against its first parent", async () => {
    const scratch = join(fixture.root, "stash and submodule");
    const env = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
      ),
      GIT_AUTHOR_NAME: "Ada",
      GIT_AUTHOR_EMAIL: "ada@example.test",
      GIT_COMMITTER_NAME: "Ada",
      GIT_COMMITTER_EMAIL: "ada@example.test",
    };
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        env,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    git(fixture.root, "clone", "--quiet", fixture.repository, scratch);
    git(scratch, "config", "core.hooksPath", "/dev/null");
    git(
      scratch,
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "--quiet",
      fixture.repository,
      "vendor/demo",
    );
    git(scratch, "commit", "-m", "Add the demo submodule");
    const head = git(scratch, "rev-parse", "HEAD");
    writeFileSync(join(scratch, "README.md"), "Stashed\n");
    git(scratch, "stash", "push", "-m", "Try a README");
    const stash = git(scratch, "rev-parse", "stash@{0}");

    const refs = refsEnvelope.parse(
      await (await post({ op: "refs", path: scratch })).json(),
    ).data;
    expect(refs.stashes).toEqual([
      {
        name: "stash@{0}",
        oid: stash,
        message: "On main: Try a README",
        timestamp: Number(git(scratch, "log", "-1", "--format=%at", stash)),
      },
    ]);
    expect(refs.submodules).toEqual([
      {
        path: "vendor/demo",
        oid: git(scratch, "rev-parse", "HEAD:vendor/demo"),
      },
    ]);
    const snapshot = snapshotEnvelope.parse(
      await (await post({ op: "snapshot", path: scratch })).json(),
    ).data;
    expect(snapshot.commits.map((commit) => commit.oid)).not.toContain(stash);
    const detail = answer("commitDetail", detailSchema).parse(
      await (
        await post({
          op: "commitDetail",
          path: scratch,
          comparison: single(stash),
        })
      ).json(),
    ).data;
    expect(detail.files.map((file) => [file.path, file.status])).toEqual([
      ["README.md", "M"],
    ]);
    expect(
      detail.target.kind === "commit" && detail.target.commit.parents[0],
    ).toBe(head);
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

  it("reads worktree entries and each side of their patches", async () => {
    const dirty = realpathSync(fixture.sync.dirty);
    expect(
      worktreeStatusEnvelope.parse(
        await (await post({ op: "worktreeStatus", path: dirty })).json(),
      ).data.entries,
    ).toEqual([
      {
        kind: "ordinary",
        path: "README.md",
        submodule: null,
        sides: { kind: "unstaged", unstaged: "M" },
        index: indexAt(dirty, "README.md"),
      },
    ]);

    const states = join(fixture.root, "worktree states");
    mkdirSync(states);
    const env = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
      ),
      GIT_AUTHOR_NAME: "Ada",
      GIT_AUTHOR_EMAIL: "ada@example.test",
      GIT_AUTHOR_DATE: "1700000000 +0000",
      GIT_COMMITTER_NAME: "Ada",
      GIT_COMMITTER_EMAIL: "ada@example.test",
      GIT_COMMITTER_DATE: "1700000000 +0000",
    };
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", states, ...args], {
        encoding: "utf8",
        env,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    git("init", "--initial-branch=main");
    git("config", "core.hooksPath", "/dev/null");
    writeFileSync(join(states, "notes.txt"), "one\ntwo\n");
    writeFileSync(join(states, "old.txt"), "a\nb\nc\nd\n");
    writeFileSync(join(states, "shared.txt"), "base\n");
    writeFileSync(join(states, "source.txt"), "1\n2\n3\n4\n5\n");
    writeFileSync(join(states, ".gitattributes"), "*.up filter=upper\n");
    git("add", ".");
    git("commit", "-m", "initial");
    git("config", "diff.renames", "copies");
    git("config", "filter.upper.clean", "tr a-z A-Z");
    writeFileSync(join(states, "draft.up"), "lower\n");
    git("switch", "-c", "theirs");
    writeFileSync(join(states, "shared.txt"), "theirs\n");
    git("commit", "-am", "theirs");
    git("switch", "main");
    writeFileSync(join(states, "shared.txt"), "ours\n");
    git("commit", "-am", "ours");
    expect(() => git("merge", "theirs")).toThrow();
    git("mv", "old.txt", "new.txt");
    writeFileSync(join(states, "notes.txt"), "one\n2\n");
    git("add", "notes.txt");
    writeFileSync(join(states, "notes.txt"), "one\n2\nthree\n");
    writeFileSync(join(states, "draft notes.txt"), "first draft\n");
    writeFileSync(join(states, "copy.txt"), "1\n2\n3\n4\n5\n");
    writeFileSync(join(states, "source.txt"), "1\n2\n3\n4\n5\n6\n");
    git("add", "copy.txt", "source.txt");
    const root = realpathSync(states);

    expect(
      worktreeStatusEnvelope.parse(
        await (await post({ op: "worktreeStatus", path: root })).json(),
      ).data,
    ).toEqual({
      root,
      stagedStamp: expect.stringMatching(/^[0-9a-f]{40}$/),
      head: {
        kind: "attached",
        reference: "refs/heads/main",
        oid: git("rev-parse", "HEAD"),
      },
      entries: [
        {
          kind: "renamed",
          path: "copy.txt",
          original: "source.txt",
          how: "copied",
          submodule: null,
          side: {
            kind: "staged",
            unstaged: null,
            index: indexAt(root, "copy.txt"),
          },
        },
        {
          kind: "renamed",
          path: "new.txt",
          original: "old.txt",
          how: "renamed",
          submodule: null,
          side: {
            kind: "staged",
            unstaged: null,
            index: indexAt(root, "new.txt"),
          },
        },
        {
          kind: "ordinary",
          path: "notes.txt",
          submodule: null,
          sides: { kind: "both", staged: "M", unstaged: "M" },
          index: indexAt(root, "notes.txt"),
        },
        {
          kind: "ordinary",
          path: "source.txt",
          submodule: null,
          sides: { kind: "staged", staged: "M" },
          index: indexAt(root, "source.txt"),
        },
        {
          kind: "unmerged",
          path: "shared.txt",
          conflict: "bothModified",
          submodule: null,
          stages: {
            base: indexAt(root, "shared.txt", "1"),
            ours: indexAt(root, "shared.txt", "2"),
            theirs: indexAt(root, "shared.txt", "3"),
          },
        },
        { kind: "untracked", path: "draft notes.txt" },
        { kind: "untracked", path: "draft.up" },
      ],
    });

    const patch = async (file: string, side: string) =>
      worktreePatchEnvelope.parse(
        await (
          await post({ op: "worktreePatch", path: root, file, side })
        ).json(),
      ).data;
    const text = (lines: string[]) => ({
      kind: "diff",
      diff: { kind: "text", lossy: false, patch: lines.join("\n") },
    });
    expect(await patch("notes.txt", "staged")).toEqual(
      text([
        "diff --git a/notes.txt b/notes.txt",
        "index 814f4a422927b82f5f8a43f8fab6d3839e3983f2..99b356dcd03dde0755c749bcd4cae4b2b73a8fa8 100644",
        "--- a/notes.txt",
        "+++ b/notes.txt",
        "@@ -1,2 +1,2 @@",
        " one",
        "-two",
        "+2",
        "",
      ]),
    );
    expect(await patch("notes.txt", "unstaged")).toEqual(
      text([
        "diff --git a/notes.txt b/notes.txt",
        "index 99b356dcd03dde0755c749bcd4cae4b2b73a8fa8..f04eb265ebd74fba2cddf0a6adf2a6a7f81c87aa 100644",
        "--- a/notes.txt",
        "+++ b/notes.txt",
        "@@ -1,2 +1,3 @@",
        " one",
        " 2",
        "+three",
        "",
      ]),
    );
    expect(await patch("copy.txt", "staged")).toEqual(
      text([
        "diff --git a/source.txt b/copy.txt",
        "similarity index 100%",
        "copy from source.txt",
        "copy to copy.txt",
        "",
      ]),
    );
    expect(await patch("new.txt", "staged")).toEqual(
      text([
        "diff --git a/old.txt b/new.txt",
        "similarity index 100%",
        "rename from old.txt",
        "rename to new.txt",
        "",
      ]),
    );
    expect(await patch("draft notes.txt", "unstaged")).toEqual(
      text([
        "diff --git a/draft notes.txt b/draft notes.txt",
        "new file mode 100644",
        "index 0000000000000000000000000000000000000000..42293fde779e36a65af4896dd9fa13f00a042c3c",
        "--- /dev/null",
        "+++ b/draft notes.txt\t",
        "@@ -0,0 +1 @@",
        "+first draft",
        "",
      ]),
    );
    expect(await patch("draft.up", "unstaged")).toEqual(
      text([
        "diff --git a/draft.up b/draft.up",
        "new file mode 100644",
        "index 0000000000000000000000000000000000000000..bd531ae71de0d872de62ebbbffc968bb4f4c8c47",
        "--- /dev/null",
        "+++ b/draft.up",
        "@@ -0,0 +1 @@",
        "+LOWER",
        "",
      ]),
    );
    const conflicted = {
      kind: "conflicted",
      conflict: "bothModified",
      diff: {
        kind: "text",
        lossy: false,
        patch: [
          "diff --git a/shared.txt b/shared.txt",
          "index b19a1e93bec1317dc6097229e12afaffbfa74dc2..5eb9640fc3f80dac61e1d3494746a7cd2aa5e64e 100644",
          "--- a/shared.txt",
          "+++ b/shared.txt",
          "@@ -1 +1,5 @@",
          "+<<<<<<< HEAD",
          " ours",
          "+=======",
          "+theirs",
          "+>>>>>>> theirs",
          "",
        ].join("\n"),
      },
    };
    expect(await patch("shared.txt", "staged")).toEqual(conflicted);
    expect(await patch("shared.txt", "unstaged")).toEqual(conflicted);
    expect(
      z
        .strictObject({ ok: z.literal(false), error: repositoryErrorSchema })
        .parse(
          await (
            await post({
              op: "worktreePatch",
              path: root,
              file: "draft notes.txt",
              side: "staged",
            })
          ).json(),
        ).error,
    ).toEqual({
      kind: "unchangedPath",
      message: "This file has no staged changes. Refresh the worktree status.",
    });
  });

  it("sends submodule, binary, and too-large patches and unreadable files across the bridge", async () => {
    const kinds = join(fixture.root, "worktree kinds");
    const sub = join(kinds, "sub");
    mkdirSync(sub, { recursive: true });
    const env = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
      ),
      GIT_AUTHOR_NAME: "Ada",
      GIT_AUTHOR_EMAIL: "ada@example.test",
      GIT_COMMITTER_NAME: "Ada",
      GIT_COMMITTER_EMAIL: "ada@example.test",
    };
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        env,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    for (const repository of [kinds, sub]) {
      git(repository, "init", "--initial-branch=main");
      git(repository, "commit", "--allow-empty", "-m", "initial");
    }
    git(kinds, "add", "sub");
    git(kinds, "commit", "-m", "submodule");
    git(sub, "commit", "--allow-empty", "-m", "moved");
    writeFileSync(join(kinds, "image.bin"), "a\0b\n");
    writeFileSync(join(kinds, "large.txt"), "x".repeat(1_500_000));
    writeFileSync(join(kinds, "locked.txt"), "x\n");
    chmodSync(join(kinds, "locked.txt"), 0o000);
    const root = realpathSync(kinds);
    const request = async (file: string) =>
      (
        await post({ op: "worktreePatch", path: root, file, side: "unstaged" })
      ).json();

    expect(worktreePatchEnvelope.parse(await request("sub")).data).toEqual({
      kind: "submodule",
      submodule: { commitChanged: true, modified: false, untracked: false },
    });
    expect(
      worktreePatchEnvelope.parse(await request("image.bin")).data,
    ).toEqual({ kind: "diff", diff: { kind: "binary" } });
    expect(
      worktreePatchEnvelope.parse(await request("large.txt")).data,
    ).toEqual({ kind: "diff", diff: { kind: "tooLarge", bytes: 1_500_000 } });
    const unreadable = z
      .strictObject({
        ok: z.literal(false),
        error: z.strictObject({
          kind: z.literal("unreadablePath"),
          message: z.string(),
        }),
      })
      .parse(await request("locked.txt")).error;
    chmodSync(join(kinds, "locked.txt"), 0o644);
    expect(unreadable).toEqual({
      kind: "unreadablePath",
      message:
        "L1 Git could not read this file (Permission denied (os error 13)). Check its permissions, then refresh.",
    });
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
      error: `unknown variant \`notAnOperation\`, expected one of ${requestOps.map((op) => `\`${op}\``).join(", ")} at line 1 column 22`,
    });
    expect(
      await rejected({ op: "commitDetail", path: fixture.repository }),
    ).toEqual({ status: 400, error: "missing field `comparison`" });
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

describe("real Rust writes, undo, and redo", () => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  const git = (path: string, ...args: string[]) =>
    execFileSync("git", ["-C", path, ...args], { encoding: "utf8", env });
  const writeEnvelope = answer("write", appliedSchema).strict();
  const undoEnvelope = answer("undo", appliedSchema).strict();
  const redoEnvelope = answer("redo", appliedSchema).strict();
  const historyEnvelope = answer("undoHistory", undoHistorySchema).strict();
  const failure = z
    .object({ ok: z.literal(false), error: repositoryErrorSchema })
    .strict();
  let repositories = 0;
  const scratch = () => join(fixture.root, `writes ${repositories++}`);
  const configure = (path: string) => {
    for (const [key, value] of Object.entries({
      "user.name": "Ada",
      "user.email": "ada@example.test",
      "commit.gpgSign": "false",
      "core.hooksPath": "/dev/null",
    }))
      git(path, "config", key, value);
    return realpathSync(path);
  };
  const clone = () => {
    const path = scratch();
    git(fixture.root, "clone", "--quiet", fixture.repository, path);
    writeFileSync(join(path, "README.md"), "# L1 demo\n\nEdited.\n");
    return configure(path);
  };
  const init = (path = scratch()) => {
    mkdirSync(path, { recursive: true });
    git(path, "init", "--quiet", "--initial-branch=main");
    return configure(path);
  };
  const committed = (files: Record<string, string>) => {
    const path = init();
    for (const [file, contents] of Object.entries(files))
      writeFileSync(join(path, file), contents);
    git(path, "add", "--all");
    git(path, "commit", "--quiet", "-m", "initial");
    return path;
  };
  const view = async (path: string) =>
    worktreeStatusEnvelope.parse(
      await (await post({ op: "worktreeStatus", path })).json(),
    ).data;
  const write = (
    path: string,
    kind: "stageFiles" | "unstageFiles",
    status: WorktreeStatus,
  ) => ({
    op: "write",
    path,
    operation: { kind, entries: status.entries },
    expect: { head: status.head },
  });
  const stage = async (path: string) =>
    write(path, "stageFiles", await view(path));
  const porcelain = (path: string) => git(path, "status", "--porcelain");
  const index = (path: string) =>
    git(path, "ls-files", "--stage", "--debug")
      .split("\n")
      .filter((line) => !line.startsWith("  ") || line.includes("flags:"))
      .map((line) => line.split("flags:").pop()?.trim())
      .join("\n");
  const roundTrip = async (
    request: { path: string; operation: unknown },
    written: () => void,
  ) => {
    const before = index(request.path);
    const applied = writeEnvelope.parse(
      await (await post(request)).json(),
    ).data;
    expect(applied).toEqual({
      id: expect.any(String),
      root: request.path,
      operation: request.operation,
    });
    written();
    expect(
      undoEnvelope.parse(
        await (
          await post({ op: "undo", path: request.path, id: applied.id })
        ).json(),
      ).data,
    ).toEqual(applied);
    expect(
      index(request.path),
      "the undo puts back every index entry and flag the write replaced",
    ).toBe(before);
  };

  it("stages a file, undoes it, and redoes it", async () => {
    const path = clone();
    expect(porcelain(path)).toBe(" M README.md\n");
    const applied = writeEnvelope.parse(
      await (await post(await stage(path))).json(),
    ).data;
    expect(applied.root).toBe(path);
    expect(porcelain(path)).toBe("M  README.md\n");
    expect(
      historyEnvelope.parse(
        await (await post({ op: "undoHistory", path })).json(),
      ).data,
    ).toEqual({ undo: applied, redo: null });
    expect(
      undoEnvelope.parse(
        await (await post({ op: "undo", path, id: applied.id })).json(),
      ).data,
    ).toEqual(applied);
    expect(porcelain(path)).toBe(" M README.md\n");
    expect(
      redoEnvelope.parse(
        await (await post({ op: "redo", path, id: applied.id })).json(),
      ).data,
    ).toEqual(applied);
    expect(porcelain(path)).toBe("M  README.md\n");
    expect(
      readdirSync(join(path, ".git")).filter(
        (name) => name === "index.lock" || name.startsWith("l1git-"),
      ),
    ).toEqual([]);
  });

  it("refuses a stale view, repeats an undo harmlessly, and refuses an unknown entry", async () => {
    const path = clone();
    const request = await stage(path);
    git(path, "add", "README.md");
    const staged = git(path, "ls-files", "--stage");
    expect(failure.parse(await (await post(request)).json()).error).toEqual({
      kind: "staleView",
      reason: "pathChanged",
      message: expect.any(String),
    });
    expect(git(path, "ls-files", "--stage")).toBe(staged);
    git(path, "reset", "--quiet", "README.md");
    const applied = writeEnvelope.parse(
      await (await post(await stage(path))).json(),
    ).data;
    for (let attempt = 0; attempt < 2; attempt++)
      expect(
        undoEnvelope.parse(
          await (await post({ op: "undo", path, id: applied.id })).json(),
        ).data,
      ).toEqual(applied);
    expect(porcelain(path)).toBe(" M README.md\n");
    expect(
      failure.parse(
        await (await post({ op: "redo", path, id: "0000000000000001" })).json(),
      ).error,
    ).toEqual({
      kind: "staleView",
      reason: "historyChanged",
      message: expect.any(String),
    });
  });

  it("rejects unknown fields in a write, an entry, and an undo", async () => {
    const path = clone();
    const request = await stage(path);
    expect(await rejected({ ...request, extra: 1 })).toEqual({
      status: 400,
      error:
        "unknown field `extra`, expected one of `path`, `operation`, `expect`",
    });
    const [entry] = request.operation.entries;
    expect(
      (
        await rejected({
          ...request,
          operation: { kind: "stageFiles", entries: [{ ...entry, extra: 1 }] },
        })
      ).status,
    ).toBe(400);
    expect(
      await rejected({ op: "undo", path, id: "0000000000000001", extra: 1 }),
    ).toEqual({
      status: 400,
      error: "unknown field `extra`, expected `path` or `id`",
    });
    expect(porcelain(path)).toBe(" M README.md\n");
  });

  it("unstages a staged rename and stages one held with intent-to-add, and undoes each", async () => {
    const path = committed({ "old.txt": "one\ntwo\nthree\n" });
    git(path, "mv", "old.txt", "new.txt");
    expect(porcelain(path)).toBe("R  old.txt -> new.txt\n");
    const staged = await view(path);
    expect(staged.entries).toMatchObject([
      {
        kind: "renamed",
        path: "new.txt",
        original: "old.txt",
        how: "renamed",
        side: {
          kind: "staged",
          unstaged: null,
          index: indexAt(path, "new.txt"),
        },
      },
    ]);
    await roundTrip(write(path, "unstageFiles", staged), () =>
      expect(porcelain(path)).toBe(" D old.txt\n?? new.txt\n"),
    );

    git(path, "reset", "--quiet");
    git(path, "add", "--intent-to-add", "new.txt");
    expect(porcelain(path)).toBe(" R old.txt -> new.txt\n");
    const held = await view(path);
    expect(held.entries).toMatchObject([
      {
        kind: "renamed",
        path: "new.txt",
        original: "old.txt",
        side: { kind: "unstaged", original: indexAt(path, "old.txt") },
      },
    ]);
    await roundTrip(write(path, "stageFiles", held), () =>
      expect(porcelain(path)).toBe("R  old.txt -> new.txt\n"),
    );
  });

  it("stages a conflict that both sides added without a base, and undoes it", async () => {
    const path = committed({ "kept.txt": "kept\n" });
    git(path, "switch", "--quiet", "-c", "theirs");
    writeFileSync(join(path, "both.txt"), "theirs\n");
    git(path, "add", "both.txt");
    git(path, "commit", "--quiet", "-m", "theirs");
    git(path, "switch", "--quiet", "main");
    writeFileSync(join(path, "both.txt"), "ours\n");
    git(path, "add", "both.txt");
    git(path, "commit", "--quiet", "-m", "ours");
    expect(() => git(path, "merge", "--quiet", "theirs")).toThrow();
    expect(porcelain(path)).toBe("AA both.txt\n");
    const status = await view(path);
    expect(status.entries).toEqual([
      {
        kind: "unmerged",
        path: "both.txt",
        conflict: "bothAdded",
        submodule: null,
        stages: {
          base: null,
          ours: indexAt(path, "both.txt", "2"),
          theirs: indexAt(path, "both.txt", "3"),
        },
      },
    ]);
    await roundTrip(write(path, "stageFiles", status), () => {
      expect(porcelain(path)).toBe("M  both.txt\n");
      expect(git(path, "ls-files", "--stage", "both.txt")).toMatch(
        /^100644 [0-9a-f]{40} 0\tboth.txt\n$/,
      );
    });
    expect(porcelain(path)).toBe("AA both.txt\n");
  });

  it("stages an untracked file and an intent-to-add file, and undoes both", async () => {
    const path = committed({ "kept.txt": "kept\n" });
    writeFileSync(join(path, "new.txt"), "new\n");
    writeFileSync(join(path, "planned.txt"), "planned\n");
    git(path, "add", "--intent-to-add", "planned.txt");
    expect(porcelain(path)).toBe(" A planned.txt\n?? new.txt\n");
    const status = await view(path);
    expect(status.entries).toEqual([
      {
        kind: "ordinary",
        path: "planned.txt",
        submodule: null,
        sides: { kind: "unstaged", unstaged: "A" },
        index: null,
      },
      { kind: "untracked", path: "new.txt" },
    ]);
    await roundTrip(write(path, "stageFiles", status), () =>
      expect(porcelain(path)).toBe("A  new.txt\nA  planned.txt\n"),
    );
    expect(porcelain(path)).toBe(" A planned.txt\n?? new.txt\n");
  });

  it("stages a submodule whose commit moved, and undoes it", async () => {
    const path = committed({ "kept.txt": "kept\n" });
    const sub = init(join(path, "sub"));
    git(sub, "commit", "--quiet", "--allow-empty", "-m", "first");
    git(path, "add", "--no-warn-embedded-repo", "sub");
    git(path, "commit", "--quiet", "-m", "add sub");
    git(sub, "commit", "--quiet", "--allow-empty", "-m", "second");
    expect(porcelain(path)).toBe(" M sub\n");
    const status = await view(path);
    expect(status.entries).toEqual([
      {
        kind: "ordinary",
        path: "sub",
        submodule: { commitChanged: true, modified: false, untracked: false },
        sides: { kind: "unstaged", unstaged: "M" },
        index: indexAt(path, "sub"),
      },
    ]);
    await roundTrip(write(path, "stageFiles", status), () => {
      expect(porcelain(path)).toBe("M  sub\n");
      expect(indexAt(path, "sub")).toEqual({
        mode: "160000",
        oid: git(sub, "rev-parse", "HEAD").trim(),
      });
    });
  });

  it("stages and unstages on an unborn HEAD and stages on a detached one, and undoes each", async () => {
    const unborn = init();
    writeFileSync(join(unborn, "first.txt"), "first\n");
    const untracked = await view(unborn);
    expect(untracked.head).toEqual({
      kind: "unborn",
      reference: "refs/heads/main",
    });
    await roundTrip(write(unborn, "stageFiles", untracked), () =>
      expect(porcelain(unborn)).toBe("A  first.txt\n"),
    );
    git(unborn, "add", "first.txt");
    const added = await view(unborn);
    expect(added.head).toEqual(untracked.head);
    await roundTrip(write(unborn, "unstageFiles", added), () =>
      expect(porcelain(unborn)).toBe("?? first.txt\n"),
    );

    const detached = clone();
    git(detached, "switch", "--quiet", "--detach");
    const status = await view(detached);
    expect(status.head).toEqual({
      kind: "detached",
      oid: git(detached, "rev-parse", "HEAD").trim(),
    });
    await roundTrip(write(detached, "stageFiles", status), () =>
      expect(porcelain(detached)).toBe("M  README.md\n"),
    );
  });

  it("answers lockHeld and unchangedPath and leaves the lock and the index alone", async () => {
    const path = clone();
    const request = await stage(path);
    const unstaged = index(path);
    const lock = join(path, ".git", "index.lock");
    writeFileSync(lock, "held");
    expect(failure.parse(await (await post(request)).json()).error.kind).toBe(
      "lockHeld",
    );
    expect(
      readFileSync(lock, "utf8"),
      "another process's lock stays as it was",
    ).toBe("held");
    expect(index(path)).toBe(unstaged);
    rmSync(lock);
    const applied = writeEnvelope.parse(
      await (await post(request)).json(),
    ).data;
    expect(porcelain(path)).toBe("M  README.md\n");

    const staged = index(path);
    const again = await stage(path);
    for (const unchanged of [
      again,
      { ...again, operation: { kind: "stageFiles", entries: [] } },
    ])
      expect(
        failure.parse(await (await post(unchanged)).json()).error.kind,
      ).toBe("unchangedPath");
    expect(index(path)).toBe(staged);
    expect(
      historyEnvelope.parse(
        await (await post({ op: "undoHistory", path })).json(),
      ).data,
      "a write that changes nothing records nothing",
    ).toEqual({ undo: applied, redo: null });
  });

  it("sends every staleView reason under its wire name", async () => {
    const path = committed({ "README.md": "one\n", z: "file\n" });
    writeFileSync(join(path, "README.md"), "two\n");
    const seen = await stage(path);
    const refusal = async (request: object) =>
      failure.parse(await (await post(request)).json()).error;
    git(path, "add", "README.md");
    const pathChanged = await refusal(seen);
    const commit = await commitRequest(path, "commit", "Mine\n");
    git(path, "reset", "--quiet", "README.md");
    const stagedChanged = await refusal(commit);
    git(path, "commit", "--quiet", "--allow-empty", "-m", "moves HEAD");
    const headMoved = await refusal(seen);
    rmSync(join(path, "z"));
    mkdirSync(join(path, "z"));
    writeFileSync(join(path, "z", "x"), "inside\n");
    const status = await view(path);
    const deletion = status.entries.filter((entry) => entry.path === "z");
    const untouched = index(path);
    const pathNotChosen = await refusal(
      write(path, "stageFiles", { ...status, entries: deletion }),
    );
    const historyChanged = await refusal({
      op: "redo",
      path,
      id: "0000000000000001",
    });
    const stale = { kind: "staleView", message: expect.any(String) };
    expect([
      headMoved,
      pathChanged,
      stagedChanged,
      pathNotChosen,
      historyChanged,
    ]).toEqual([
      { ...stale, reason: "headMoved" },
      { ...stale, reason: "pathChanged" },
      { ...stale, reason: "stagedChanged" },
      { ...stale, reason: "pathNotChosen", paths: ["z/x"] },
      { ...stale, reason: "historyChanged" },
    ]);
    expect(index(path), "no refusal changes the index").toBe(untouched);
  });

  it("rejects a write entry that omits its index or its submodule", async () => {
    const path = clone();
    const request = await stage(path);
    expect(request.operation.entries).toMatchObject([
      {
        kind: "ordinary",
        submodule: null,
        index: indexAt(path, "README.md"),
      },
    ]);
    const before = index(path);
    for (const field of ["index", "submodule"]) {
      const response = await post({
        ...request,
        operation: {
          kind: "stageFiles",
          entries: request.operation.entries.map((entry) =>
            Object.fromEntries(
              Object.entries(entry).filter(([key]) => key !== field),
            ),
          ),
        },
      });
      expect(
        { status: response.status, body: await response.json() },
        `a write entry without \`${field}\` is malformed`,
      ).toEqual({
        status: 400,
        body: {
          error: expect.stringMatching(
            new RegExp(`missing field \`${field}\``),
          ),
        },
      });
      expect(index(path)).toBe(before);
    }
    expect(porcelain(path)).toBe(" M README.md\n");
  });

  const statusOf = async (path: string) =>
    worktreeStatusEnvelope.parse(
      await (await post({ op: "worktreeStatus", path })).json(),
    ).data;
  const commitRequest = async (
    path: string,
    kind: "commit" | "amend" | "editMessage",
    message: string,
  ) => {
    const status = await statusOf(path);
    return {
      op: "write",
      path,
      operation:
        kind === "editMessage"
          ? { kind, message }
          : { kind, message, staged: status.stagedStamp },
      expect: { head: status.head },
    };
  };
  const head = (path: string) => git(path, "rev-parse", "HEAD").trim();
  const commitFailure = async (request: unknown) =>
    failure.parse(await (await post(request)).json()).error;

  it("commits the staged files, undoes to the parent with them staged, and redoes to the same commit", async () => {
    const path = clone();
    git(path, "add", "README.md");
    const parent = head(path);
    const applied = writeEnvelope.parse(
      await (
        await post(await commitRequest(path, "commit", "Update readme\n"))
      ).json(),
    ).data;
    const made = head(path);
    expect(git(path, "log", "-1", "--format=%s%n%P")).toBe(
      `Update readme\n${parent}\n`,
    );
    expect(porcelain(path)).toBe("");
    undoEnvelope.parse(
      await (await post({ op: "undo", path, id: applied.id })).json(),
    );
    expect(head(path)).toBe(parent);
    expect(porcelain(path)).toBe("M  README.md\n");
    redoEnvelope.parse(
      await (await post({ op: "redo", path, id: applied.id })).json(),
    );
    expect(head(path)).toBe(made);
    expect(porcelain(path)).toBe("");
  });

  it("amends with the staged files, keeping parents and author, and edits a message alone", async () => {
    const path = clone();
    const before = git(path, "log", "-1", "--format=%H%n%P%n%an <%ae> %ad");
    const [old, parents, author] = before.trim().split("\n");
    git(path, "add", "README.md");
    const amended = writeEnvelope.parse(
      await (
        await post(await commitRequest(path, "amend", "Amended\n"))
      ).json(),
    ).data;
    expect(git(path, "log", "-1", "--format=%s%n%P%n%an <%ae> %ad")).toBe(
      `Amended\n${parents}\n${author}\n`,
    );
    expect(porcelain(path)).toBe("");
    undoEnvelope.parse(
      await (await post({ op: "undo", path, id: amended.id })).json(),
    );
    expect(head(path)).toBe(old);
    expect(porcelain(path)).toBe("M  README.md\n");
    const tree = git(path, "rev-parse", "HEAD^{tree}");
    writeEnvelope.parse(
      await (
        await post(await commitRequest(path, "editMessage", "Reworded\n"))
      ).json(),
    );
    expect(git(path, "log", "-1", "--format=%s%n%P")).toBe(
      `Reworded\n${parents}\n`,
    );
    expect(git(path, "rev-parse", "HEAD^{tree}")).toBe(tree);
    expect(porcelain(path)).toBe("M  README.md\n");
  });

  it("makes a first commit and undoes it back to an unborn HEAD", async () => {
    const path = init();
    writeFileSync(join(path, "f"), "first\n");
    git(path, "add", "f");
    const applied = writeEnvelope.parse(
      await (await post(await commitRequest(path, "commit", "First\n"))).json(),
    ).data;
    expect(git(path, "log", "--format=%s %P")).toBe("First \n");
    undoEnvelope.parse(
      await (await post({ op: "undo", path, id: applied.id })).json(),
    );
    expect(() => git(path, "rev-parse", "-q", "--verify", "HEAD")).toThrow();
    expect(porcelain(path)).toBe("A  f\n");
  });

  it("refuses a stale staged list, nothing staged, a merge in progress, a failing hook, and a missing identity", async () => {
    const path = clone();
    const start = head(path);
    expect(
      (await commitFailure(await commitRequest(path, "commit", "A\n"))).kind,
    ).toBe("unchangedPath");
    git(path, "add", "README.md");
    const stale = await commitRequest(path, "commit", "A\n");
    writeFileSync(join(path, "other.txt"), "other\n");
    git(path, "add", "other.txt");
    expect((await commitFailure(stale)).kind).toBe("staleView");

    writeFileSync(join(path, ".git", "MERGE_HEAD"), `${start}\n`);
    const merging = await commitFailure(
      await commitRequest(path, "commit", "A\n"),
    );
    expect(merging.kind).toBe("conflict");
    expect(merging.message).toContain("merge");
    rmSync(join(path, ".git", "MERGE_HEAD"));

    const hooks = scratch();
    mkdirSync(hooks);
    writeFileSync(
      join(hooks, "pre-commit"),
      "#!/bin/sh\necho 'lint failed: TODO'\nexit 1\n",
      { mode: 0o755 },
    );
    git(path, "config", "core.hooksPath", hooks);
    const hook = await commitFailure(
      await commitRequest(path, "commit", "A\n"),
    );
    expect(hook.kind).toBe("hookFailed");
    expect("output" in hook && hook.output).toContain("lint failed: TODO");
    git(path, "config", "--unset", "core.hooksPath");

    git(path, "config", "user.name", "");
    expect(
      (await commitFailure(await commitRequest(path, "commit", "A\n"))).kind,
    ).toBe("missingIdentity");
    expect(head(path)).toBe(start);
  });

  it("rejects an unknown field in a commit", async () => {
    const path = clone();
    const request = await commitRequest(path, "commit", "A\n");
    expect(
      (
        await rejected({
          ...request,
          operation: { ...request.operation, extra: 1 },
        })
      ).status,
    ).toBe(400);
  });

  const discardRequest = async (path: string, paths: string[]) => {
    const status = await view(path);
    return {
      op: "write",
      path,
      operation: {
        kind: "discard",
        entries: status.entries.filter((entry) => paths.includes(entry.path)),
      },
      expect: { head: status.head },
    };
  };

  it("creates, renames, and deletes a branch, undoes each, and says what a branch is not merged into", async () => {
    const path = clone();
    const refs = () =>
      git(
        path,
        "for-each-ref",
        "--format=%(refname) %(objectname)",
        "refs/heads/",
      );
    const head = git(path, "rev-parse", "HEAD").trim();
    const theme = git(path, "rev-parse", "HEAD~1").trim();
    const expect_ = {
      head: {
        kind: "attached",
        reference: git(path, "symbolic-ref", "HEAD").trim(),
        oid: head,
      },
    };
    const branchWrite = (operation: unknown) => ({
      op: "write",
      path,
      operation,
      expect: expect_,
    });
    const step = async (op: "undo" | "redo", id: string) =>
      (op === "undo" ? undoEnvelope : redoEnvelope).parse(
        await (await post({ op, path, id })).json(),
      ).data;
    const before = refs();
    const create = {
      kind: "createBranch",
      name: "topic",
      at: { kind: "commit", oid: theme },
    };
    const created = writeEnvelope.parse(
      await (await post(branchWrite(create))).json(),
    ).data;
    expect(created.operation).toEqual(create);
    expect(git(path, "rev-parse", "topic").trim()).toBe(theme);
    const rename = {
      kind: "renameBranch",
      branch: { reference: "refs/heads/topic", oid: theme },
      to: "feat/topic",
    };
    const renamed = writeEnvelope.parse(
      await (await post(branchWrite(rename))).json(),
    ).data;
    expect(git(path, "rev-parse", "feat/topic").trim()).toBe(theme);
    const merged = answer("branchMerged", branchMergedSchema).strict();
    expect(
      merged.parse(
        await (
          await post({
            op: "branchMerged",
            path,
            branch: { reference: "refs/heads/feat/topic", oid: theme },
          })
        ).json(),
      ).data,
    ).toEqual({ head: true, upstream: null });
    const deleted = writeEnvelope.parse(
      await (
        await post(
          branchWrite({
            kind: "deleteBranch",
            branch: { reference: "refs/heads/feat/topic", oid: theme },
          }),
        )
      ).json(),
    ).data;
    expect(refs()).toBe(before);
    for (const applied of [deleted, renamed, created])
      expect(await step("undo", applied.id)).toEqual(applied);
    expect(refs()).toBe(before);
    for (const applied of [created, renamed])
      expect(await step("redo", applied.id)).toEqual(applied);
    expect(git(path, "rev-parse", "feat/topic").trim()).toBe(theme);

    const stale = failure.parse(
      await (
        await post(
          branchWrite({
            kind: "deleteBranch",
            branch: { reference: "refs/heads/feat/topic", oid: head },
          }),
        )
      ).json(),
    );
    expect(stale.error).toMatchObject({
      kind: "staleView",
      reason: "branchChanged",
    });
    const invalid = failure.parse(
      await (await post(branchWrite({ ...create, name: "bad..name" }))).json(),
    );
    expect(invalid.error).toEqual({
      kind: "invalidRef",
      message: "'bad..name' is not a valid branch name.",
    });
  });

  it("creates a lightweight and an annotated tag, deletes an annotated one, and undoes and redoes each", async () => {
    const path = clone();
    const head = git(path, "rev-parse", "HEAD").trim();
    const tags = () =>
      git(
        path,
        "for-each-ref",
        "--format=%(refname) %(objectname)",
        "refs/tags/",
      );
    const tagWrite = (operation: object) => ({
      op: "write",
      path,
      operation,
      expect: {
        head: {
          kind: "attached",
          reference: git(path, "symbolic-ref", "HEAD").trim(),
          oid: head,
        },
      },
    });
    const written = async (operation: object) => {
      const applied = writeEnvelope.parse(
        await (await post(tagWrite(operation))).json(),
      ).data;
      expect(applied).toEqual({
        id: expect.any(String),
        root: path,
        operation,
      });
      return applied;
    };
    const step = async (op: "undo" | "redo", id: string) =>
      (op === "undo" ? undoEnvelope : redoEnvelope).parse(
        await (await post({ op, path, id })).json(),
      ).data;
    const refusal = async (operation: object) =>
      failure.parse(await (await post(tagWrite(operation))).json()).error;
    const kind = (tag: string) => git(path, "cat-file", "-t", tag).trim();
    const before = tags();

    const light = await written({
      kind: "createTag",
      name: "v0.2.0",
      at: head,
      message: null,
    });
    expect(kind("v0.2.0")).toBe("commit");
    expect(git(path, "rev-parse", "v0.2.0").trim()).toBe(head);
    const annotated = await written({
      kind: "createTag",
      name: "v0.3.0",
      at: head,
      message: "Third release\n",
    });
    expect(kind("v0.3.0")).toBe("tag");
    const body = git(path, "cat-file", "-p", "v0.3.0");
    expect(body).toContain(`object ${head}\n`);
    expect(body).toContain("tagger Ada <ada@example.test>");
    expect(body.endsWith("\n\nThird release\n")).toBe(true);
    const made = tags();
    for (const applied of [annotated, light])
      expect(await step("undo", applied.id)).toEqual(applied);
    expect(tags()).toBe(before);
    for (const applied of [light, annotated])
      expect(await step("redo", applied.id)).toEqual(applied);
    expect(tags()).toBe(made);

    const object = git(path, "rev-parse", "refs/tags/v0.1.0").trim();
    expect(kind(object)).toBe("tag");
    const deleted = await written({
      kind: "deleteTag",
      tag: { reference: "refs/tags/v0.1.0", oid: object },
    });
    expect(git(path, "for-each-ref", "refs/tags/v0.1.0")).toBe("");
    expect(await step("undo", deleted.id)).toEqual(deleted);
    expect(git(path, "rev-parse", "refs/tags/v0.1.0").trim()).toBe(object);
    expect(tags()).toBe(made);

    expect(
      await refusal({
        kind: "createTag",
        name: "v0..1",
        at: head,
        message: null,
      }),
    ).toEqual({
      kind: "invalidRef",
      message: "'v0..1' is not a valid tag name.",
    });
    git(path, "tag", "-f", "v0.1.0", "HEAD");
    const moved = tags();
    expect(
      await refusal({
        kind: "deleteTag",
        tag: { reference: "refs/tags/v0.1.0", oid: object },
      }),
    ).toEqual({
      kind: "staleView",
      reason: "tagChanged",
      message:
        "v0.1.0 no longer points where L1 Git showed, so nothing changed. Refresh and try again.",
    });
    expect(
      (
        await rejected(
          tagWrite({
            kind: "createTag",
            name: "v0.4.0",
            at: head,
            message: null,
            extra: 1,
          }),
        )
      ).status,
    ).toBe(400);
    expect(tags(), "no refusal changes a tag").toBe(moved);
  });

  it("checks out a local branch, a commit, and a remote branch it creates, and undoes each", async () => {
    const path = clone();
    const main = git(path, "rev-parse", "HEAD").trim();
    const merge = git(path, "rev-parse", "HEAD~1").trim();
    const history = git(path, "rev-parse", "origin/feat/history").trim();
    git(path, "branch", "topic", merge);
    const onMain = {
      kind: "attached",
      reference: "refs/heads/main",
      oid: main,
    };
    const checkout = (target: unknown) => ({
      op: "write",
      path,
      operation: { kind: "checkout", target },
      expect: { head: onMain },
    });
    const written = async (request: ReturnType<typeof checkout>) => {
      const applied = writeEnvelope.parse(
        await (await post(request)).json(),
      ).data;
      expect(applied).toEqual({
        id: expect.any(String),
        root: path,
        operation: request.operation,
      });
      return applied;
    };
    const step = async (op: "undo" | "redo", id: string) =>
      (op === "undo" ? undoEnvelope : redoEnvelope).parse(
        await (await post({ op, path, id })).json(),
      ).data;
    const headName = () =>
      git(path, "rev-parse", "--symbolic-full-name", "HEAD").trim();
    const tracking = () =>
      git(path, "config", "--local", "--list")
        .split("\n")
        .filter((line) => line.startsWith("branch.feat/history."))
        .sort();
    const tracksOrigin = [
      "branch.feat/history.merge=refs/heads/feat/history",
      "branch.feat/history.remote=origin",
    ];

    const local = await written(
      checkout({ kind: "local", reference: "refs/heads/topic", oid: merge }),
    );
    expect(headName()).toBe("refs/heads/topic");
    expect(porcelain(path)).toBe(" M README.md\n");
    expect(await step("undo", local.id)).toEqual(local);
    expect(headName()).toBe("refs/heads/main");

    const detached = await written(checkout({ kind: "commit", oid: merge }));
    expect(headName()).toBe("HEAD");
    expect(git(path, "rev-parse", "HEAD").trim()).toBe(merge);
    expect(await step("undo", detached.id)).toEqual(detached);
    expect(headName()).toBe("refs/heads/main");

    expect(git(path, "for-each-ref", "refs/heads/feat/history")).toBe("");
    const remote = await written(
      checkout({
        kind: "remote",
        reference: "refs/remotes/origin/feat/history",
        oid: history,
      }),
    );
    expect(headName()).toBe("refs/heads/feat/history");
    expect(git(path, "rev-parse", "refs/heads/feat/history").trim()).toBe(
      history,
    );
    expect(tracking()).toEqual(tracksOrigin);
    expect(await step("undo", remote.id)).toEqual(remote);
    expect(headName()).toBe("refs/heads/main");
    expect(git(path, "for-each-ref", "refs/heads/feat/history")).toBe("");
    expect(tracking()).toEqual([]);
    expect(git(path, "rev-parse", "HEAD").trim()).toBe(main);
    expect(porcelain(path)).toBe(" M README.md\n");
    expect(await step("redo", remote.id)).toEqual(remote);
    expect(headName()).toBe("refs/heads/feat/history");
    expect(tracking()).toEqual(tracksOrigin);

    expect(
      (await rejected(checkout({ kind: "commit", oid: merge, extra: 1 })))
        .status,
    ).toBe(400);
    expect(headName()).toBe("refs/heads/feat/history");
  });

  it("discards a tracked and an untracked file, undoes them byte for byte, and redoes them", async () => {
    const path = clone();
    writeFileSync(join(path, "notes.txt"), "untracked\n");
    chmodSync(join(path, "README.md"), 0o600);
    const request = await discardRequest(path, ["README.md", "notes.txt"]);
    const applied = writeEnvelope.parse(
      await (await post(request)).json(),
    ).data;
    expect(applied).toEqual({
      id: expect.any(String),
      root: path,
      operation: request.operation,
    });
    expect(porcelain(path)).toBe("");
    expect(readdirSync(path)).not.toContain("notes.txt");

    undoEnvelope.parse(
      await (await post({ op: "undo", path, id: applied.id })).json(),
    );
    expect(readFileSync(join(path, "README.md"), "utf8")).toBe(
      "# L1 demo\n\nEdited.\n",
    );
    expect(readFileSync(join(path, "notes.txt"), "utf8")).toBe("untracked\n");
    expect(statSync(join(path, "README.md")).mode & 0o777).toBe(0o600);
    expect(porcelain(path)).toBe(" M README.md\n?? notes.txt\n");

    redoEnvelope.parse(
      await (await post({ op: "redo", path, id: applied.id })).json(),
    );
    expect(porcelain(path)).toBe("");
  });

  it("refuses a stale view, a nested repository, and an unknown field in a discard", async () => {
    const path = clone();
    const request = await discardRequest(path, ["README.md"]);
    git(path, "add", "README.md");
    expect(failure.parse(await (await post(request)).json()).error).toEqual({
      kind: "staleView",
      reason: "pathChanged",
      message: expect.any(String),
    });
    expect(porcelain(path)).toBe("M  README.md\n");

    init(join(path, "nested"));
    const nested = await discardRequest(path, ["nested/"]);
    expect(nested.operation.entries).toHaveLength(1);
    expect(failure.parse(await (await post(nested)).json()).error).toEqual({
      kind: "unsupportedPath",
      message: expect.stringContaining("nested repository"),
    });
    expect(
      (
        await rejected({
          ...nested,
          operation: { ...nested.operation, extra: 1 },
        })
      ).status,
    ).toBe(400);
  });

  const numbered = (count: number) =>
    Array.from({ length: count }, (_, at) => `line ${at + 1}\n`).join("");
  const edited = (text: string, lines: Record<number, string>) =>
    text
      .split(/(?<=\n)/)
      .map((line, at) => lines[at + 1] ?? line)
      .join("");
  const threeHunks = edited(numbered(30), {
    3: "line 3 changed\n",
    15: "line 15 changed\n",
    27: "line 27 changed\n",
  });
  const shownPatch = async (
    path: string,
    file: string,
    side: "staged" | "unstaged",
  ) => {
    const patch = worktreePatchEnvelope.parse(
      await (await post({ op: "worktreePatch", path, file, side })).json(),
    ).data;
    if (patch.kind !== "diff" || patch.diff.kind !== "text")
      throw new Error(`${file} has no text patch on its ${side} side`);
    return patch.diff.patch;
  };
  const partWrite = async (
    path: string,
    operation: Record<string, unknown> & { kind: string; path: string },
  ) => {
    const side = operation.kind.startsWith("unstage") ? "staged" : "unstaged";
    return {
      op: "write",
      path,
      operation: {
        ...operation,
        shown: await shownPatch(path, operation.path, side),
      },
      expect: { head: (await view(path)).head },
    };
  };
  const staged = (path: string, file: string) => git(path, "show", `:${file}`);

  it("stages, unstages, and discards a hunk and chosen lines, and undoes each", async () => {
    const path = committed({ "f.txt": numbered(30) });
    writeFileSync(join(path, "f.txt"), threeHunks);
    await roundTrip(
      await partWrite(path, { kind: "stageHunk", path: "f.txt", hunk: 1 }),
      () =>
        expect(staged(path, "f.txt")).toBe(
          edited(numbered(30), { 15: "line 15 changed\n" }),
        ),
    );
    await roundTrip(
      await partWrite(path, {
        kind: "stageLines",
        path: "f.txt",
        lines: [
          { side: "deletions", line: 27 },
          { side: "additions", line: 27 },
        ],
      }),
      () =>
        expect(staged(path, "f.txt")).toBe(
          edited(numbered(30), { 27: "line 27 changed\n" }),
        ),
    );

    git(path, "add", "f.txt");
    await roundTrip(
      await partWrite(path, { kind: "unstageHunk", path: "f.txt", hunk: 2 }),
      () =>
        expect(staged(path, "f.txt")).toBe(
          edited(threeHunks, { 27: "line 27\n" }),
        ),
    );
    await roundTrip(
      await partWrite(path, {
        kind: "unstageLines",
        path: "f.txt",
        lines: [
          { side: "deletions", line: 3 },
          { side: "additions", line: 3 },
        ],
      }),
      () =>
        expect(staged(path, "f.txt")).toBe(
          edited(threeHunks, { 3: "line 3\n" }),
        ),
    );
    git(path, "reset", "--quiet");

    const discard = await partWrite(path, {
      kind: "discardHunk",
      path: "f.txt",
      hunk: 0,
    });
    const applied = writeEnvelope.parse(
      await (await post(discard)).json(),
    ).data;
    expect(applied.operation).toEqual(discard.operation);
    expect(readFileSync(join(path, "f.txt"), "utf8")).toBe(
      edited(threeHunks, { 3: "line 3\n" }),
    );
    undoEnvelope.parse(
      await (await post({ op: "undo", path, id: applied.id })).json(),
    );
    expect(readFileSync(join(path, "f.txt"), "utf8")).toBe(threeHunks);

    writeFileSync(join(path, "new.txt"), "one\ntwo\nthree\n");
    const lines = await partWrite(path, {
      kind: "discardLines",
      path: "new.txt",
      lines: [{ side: "additions", line: 2 }],
    });
    const removed = writeEnvelope.parse(await (await post(lines)).json()).data;
    expect(readFileSync(join(path, "new.txt"), "utf8")).toBe("one\nthree\n");
    expect(porcelain(path)).toBe(" M f.txt\n?? new.txt\n");
    undoEnvelope.parse(
      await (await post({ op: "undo", path, id: removed.id })).json(),
    );
    expect(readFileSync(join(path, "new.txt"), "utf8")).toBe(
      "one\ntwo\nthree\n",
    );
    expect(
      historyEnvelope.parse(
        await (await post({ op: "undoHistory", path })).json(),
      ).data.redo,
    ).toEqual(removed);
  });

  it("refuses a hunk write whose shown patch is stale, and an unknown field", async () => {
    const path = committed({ "f.txt": numbered(30) });
    writeFileSync(join(path, "f.txt"), threeHunks);
    const request = await partWrite(path, {
      kind: "stageHunk",
      path: "f.txt",
      hunk: 1,
    });
    writeFileSync(join(path, "f.txt"), `inserted\n${threeHunks}`);
    const before = index(path);
    expect(failure.parse(await (await post(request)).json()).error).toEqual({
      kind: "staleView",
      reason: "pathChanged",
      message: "This file changed. Refresh to see its current diff.",
    });
    expect(index(path)).toBe(before);
    expect(
      (
        await rejected({
          ...request,
          operation: { ...request.operation, side: "unstaged" },
        })
      ).status,
    ).toBe(400);
  });

  it("stages a hunk of a 900 KiB patch and answers 400 naming the size of a 5 MiB body", async () => {
    const wide = `start\n${Array.from(
      { length: 15_000 },
      (_, at) => `line ${String(at).padStart(6, "0")} ${"x".repeat(50)}\n`,
    ).join("")}`;
    const path = committed({ "big.txt": "start\n" });
    writeFileSync(join(path, "big.txt"), wide);
    const request = await partWrite(path, {
      kind: "stageHunk",
      path: "big.txt",
      hunk: 0,
    });
    expect(request.operation.shown.length).toBeGreaterThan(900 * 1024);
    writeEnvelope.parse(await (await post(request)).json());
    expect(staged(path, "big.txt")).toBe(wide);

    const tooLarge = await rejected({
      ...request,
      operation: { ...request.operation, shown: "x".repeat(5 * 1024 * 1024) },
    });
    expect(tooLarge.status).toBe(400);
    expect(tooLarge.error).toMatch(
      /^The request body is \d+ bytes, over the 4194304-byte limit\.$/,
    );
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

describe("real Rust read deadlines", () => {
  it("returns timedOut for a commit read that hangs and still reads other commits", async () => {
    const snapshot = snapshotEnvelope.parse(
      await (await post({ op: "snapshot", path: fixture.repository })).json(),
    ).data;
    const [slow, other] = snapshot.commits;
    if (!slow || !other) throw new Error("The fixture needs two commits");
    const real = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const bin = join(fixture.root, "slow-git-bin");
    const masks = join(fixture.root, "slow-git-masks");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\nfor arg in "$@"; do [ "$arg" = ${slow.oid} ] && { perl -MPOSIX -e 'my $s = POSIX::SigSet->new; sigprocmask(SIG_BLOCK, POSIX::SigSet->new, $s); print join(",", grep { $s->ismember($_) } 1, 2, 15), "\\n"' >> '${masks}'; exec sleep 30; }; done\nexec '${real}' "$@"\n`,
    );
    chmodSync(join(bin, "git"), 0o755);
    const slowBridge = await startBridge({
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      L1GIT_READ_DEADLINE_MS: "1000",
    });
    const read = async (oid: string) =>
      (
        await fetch(`${slowBridge.endpoint}/api/run`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: origin },
          body: JSON.stringify({
            op: "commitDetail",
            path: fixture.repository,
            comparison: single(oid),
          }),
        })
      ).json();
    try {
      const started = performance.now();
      const failed = z
        .object({ ok: z.literal(false), error: repositoryErrorSchema })
        .strict()
        .parse(await read(slow.oid));
      const elapsed = performance.now() - started;
      expect(failed.error).toEqual({
        kind: "timedOut",
        message:
          "Reading this commit took longer than 1 s, so L1 Git stopped Git. Retry. If it happens again, check for a slow disk or a Git filter that does not finish.",
      });
      expect(readFileSync(masks, "utf8")).toBe("\n");
      expect(elapsed).toBeGreaterThanOrEqual(1000);
      expect(elapsed).toBeLessThan(2000);
      const detail = answer("commitDetail", detailSchema).parse(
        await read(other.oid),
      ).data;
      expect(detail.target).toMatchObject({
        kind: "commit",
        commit: { oid: other.oid },
      });
    } finally {
      slowBridge.bridge.kill();
      await once(slowBridge.bridge, "exit");
    }
  }, 20_000);

  it("stops a hung read's Git when the bridge gets Ctrl-C", async () => {
    const snapshot = snapshotEnvelope.parse(
      await (await post({ op: "snapshot", path: fixture.repository })).json(),
    ).data;
    const slow = snapshot.commits[2];
    if (!slow) throw new Error("The fixture needs three commits");
    const real = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const bin = join(fixture.root, "hung-git-bin");
    const pids = join(fixture.root, "hung-git-pids");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\nfor arg in "$@"; do [ "$arg" = ${slow.oid} ] && { echo $$ >> '${pids}'; exec sleep 60; }; done\nexec '${real}' "$@"\n`,
    );
    chmodSync(join(bin, "git"), 0o755);
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const hungBridge = await startBridge({
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    });
    let pid = Number.NaN;
    try {
      void fetch(`${hungBridge.endpoint}/api/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({
          op: "commitDetail",
          path: fixture.repository,
          comparison: single(slow.oid),
        }),
      }).catch(() => undefined);
      for (let attempt = 0; attempt < 100 && Number.isNaN(pid); attempt++) {
        await setTimeout(50);
        try {
          pid = Number.parseInt(readFileSync(pids, "utf8"), 10);
        } catch {
          pid = Number.NaN;
        }
      }
      expect(pid).toBeGreaterThan(1);
      expect(alive(pid)).toBe(true);
      const exited = once(hungBridge.bridge, "exit");
      const interrupted = performance.now();
      hungBridge.bridge.kill("SIGINT");
      expect(await exited).toEqual([null, "SIGINT"]);
      expect(performance.now() - interrupted).toBeLessThan(1000);
      for (let attempt = 0; attempt < 20 && alive(pid); attempt++)
        await setTimeout(25);
      expect(alive(pid)).toBe(false);
    } finally {
      if (
        hungBridge.bridge.exitCode === null &&
        hungBridge.bridge.signalCode === null
      ) {
        hungBridge.bridge.kill("SIGKILL");
        await once(hungBridge.bridge, "exit");
      }
      const ownSleep =
        Number.isInteger(pid) &&
        pid > 1 &&
        alive(pid) &&
        execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
          encoding: "utf8",
        }).trim() === "sleep 60";
      if (ownSleep) process.kill(pid, "SIGKILL");
    }
  }, 20_000);
});

describe("real Rust prepared current-branch push contract", () => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  const git = (path: string, ...args: string[]) =>
    execFileSync("git", ["-C", path, ...args], {
      encoding: "utf8",
      env,
    }).trim();
  const prepare = async (path: string) =>
    answer("preparePush", pushAvailabilitySchema).parse(
      await (await post({ op: "preparePush", path })).json(),
    ).data;
  const push = async (path: string, intent: unknown) =>
    answer("push", pushReportSchema).parse(
      await (await post({ op: "push", path, intent })).json(),
    ).data;
  const refs = (path: string) =>
    git(path, "for-each-ref", "--format=%(refname) %(objectname)");
  const local = (path: string) => ({
    head: git(path, "rev-parse", "HEAD"),
    index: git(path, "ls-files", "-s"),
    file: readFileSync(join(path, "f"), "utf8"),
  });

  it("publishes only the reviewed upstream and refreshes outgoing counts without a fetch", async () => {
    const path = join(fixture.root, "push-contract");
    const remote = join(fixture.root, "push-contract.git");
    git(fixture.root, "init", "--initial-branch=main", path);
    git(fixture.root, "init", "--bare", remote);
    git(path, "config", "core.hooksPath", "/dev/null");
    writeFileSync(join(path, "f"), "one\n");
    git(path, "add", "f");
    git(
      path,
      "-c",
      "user.name=Ada",
      "-c",
      "user.email=ada@example.test",
      "commit",
      "-m",
      "one",
    );
    git(path, "remote", "add", "origin", remote);
    git(path, "push", "origin", "HEAD:refs/heads/reviewed");
    git(path, "config", "branch.main.remote", "origin");
    git(path, "config", "branch.main.merge", "refs/heads/reviewed");
    const beforeRemote = refs(remote);
    const initial = git(path, "rev-parse", "HEAD");
    git(
      path,
      "-c",
      "user.name=Ada",
      "-c",
      "user.email=ada@example.test",
      "commit",
      "--allow-empty",
      "-m",
      "two",
    );
    const expected = git(path, "rev-parse", "HEAD");
    writeFileSync(join(path, "f"), "dirty\n");
    const before = local(path);
    const history = await (await post({ op: "undoHistory", path })).json();
    const prepared = await prepare(path);
    expect(prepared.kind).toBe("ready");
    if (prepared.kind !== "ready")
      throw new Error("Expected configured upstream");
    expect(prepared.intent).toMatchObject({
      branch: "refs/heads/main",
      source: expected,
      remote: "origin",
      destination: "refs/heads/reviewed",
    });
    const report = await push(path, prepared.intent);
    expect(report.outcome.kind).toBe("pushed");
    expect(report.refresh.kind).toBe("refreshed");
    if (report.refresh.kind === "refreshed")
      expect(
        report.refresh.overview.branches.find(({ name }) => name === "main")
          ?.state.kind,
      ).toBe("upToDate");
    expect(refs(remote)).toBe(beforeRemote.replace(initial, expected));
    expect(local(path)).toEqual(before);
    expect(await (await post({ op: "undoHistory", path })).json()).toEqual(
      history,
    );
    expect((await push(path, prepared.intent)).outcome.kind).toBe("upToDate");
    expect(
      (
        await push(path, {
          ...prepared.intent,
          destination: "refs/heads/unreviewed",
        })
      ).outcome.kind,
    ).toBe("stale");
    expect(refs(remote)).toBe(beforeRemote.replace(initial, expected));
    expect(
      (
        await rejected({
          op: "push",
          path,
          intent: { ...prepared.intent, force: true },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await rejected({
          op: "push",
          path,
          intent: { ...prepared.intent, source: "HEAD" },
        })
      ).status,
    ).toBe(400);

    const hooks = join(fixture.root, "push-hooks");
    mkdirSync(hooks);
    const hook = join(hooks, "pre-push");
    writeFileSync(
      hook,
      "#!/bin/sh\ngit config remote.origin.fetch 'invalid:ref:spec'\n",
    );
    chmodSync(hook, 0o755);
    git(path, "config", "core.hooksPath", hooks);
    git(
      path,
      "-c",
      "user.name=Ada",
      "-c",
      "user.email=ada@example.test",
      "commit",
      "--allow-empty",
      "-m",
      "three",
    );
    const current = await prepare(path);
    if (current.kind !== "ready")
      throw new Error("Expected configured upstream");
    const accepted = await push(path, current.intent);
    expect(accepted.outcome.kind).toBe("pushed");
    expect(accepted.refresh.kind).toBe("failed");
    expect(refs(remote)).toBe(
      beforeRemote.replace(initial, current.intent.source),
    );
  });

  it("returns explicit unavailable states and never leaks endpoint credentials", async () => {
    expect(await prepare(fixture.unborn)).toEqual({
      kind: "unavailable",
      reason: "unborn",
    });
    expect(await prepare(fixture.detached)).toEqual({
      kind: "unavailable",
      reason: "detached",
    });
    const path = join(fixture.root, "push-redaction");
    git(fixture.root, "init", "--initial-branch=main", path);
    git(
      path,
      "-c",
      "user.name=Ada",
      "-c",
      "user.email=ada@example.test",
      "commit",
      "--allow-empty",
      "-m",
      "one",
    );
    expect(await prepare(path)).toEqual({
      kind: "unavailable",
      reason: "noUpstream",
    });
    git(
      path,
      "remote",
      "add",
      "origin",
      "https://user:secret@example.invalid/repo?token=hidden",
    );
    git(path, "config", "branch.main.remote", "origin");
    git(path, "config", "branch.main.merge", "refs/heads/main");
    const prepared = await prepare(path);
    expect(prepared.kind).toBe("ready");
    expect(JSON.stringify(prepared)).not.toMatch(/secret|hidden|user:|token=/);
  });
});
