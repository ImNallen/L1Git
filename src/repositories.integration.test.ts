import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { rmSync } from "node:fs";
import { createServer } from "node:net";
import { setTimeout } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  detailSchema,
  repositoryErrorSchema,
  snapshotSchema,
} from "./domain/repository";

const fixtureSchema = z.object({
  root: z.string(),
  repository: z.string(),
  remote: z.string(),
  unborn: z.string(),
  detached: z.string(),
});
let fixture: z.infer<typeof fixtureSchema>;
let bridge: ChildProcess;
let endpoint: string;
const origin = "http://127.0.0.1:1422";
const snapshotEnvelope = z.object({
  ok: z.literal(true),
  data: snapshotSchema,
});

async function post(
  operation: string,
  body: unknown,
  requestOrigin: string | null = origin,
) {
  return fetch(`${endpoint}/api/${operation}`, {
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
      await post("snapshot", { path: fixture.unborn });
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
  it("parses a real repository, browses a remote ref, and reads first-parent merge details", async () => {
    const response = await post("snapshot", { path: fixture.repository });
    const snapshot = snapshotEnvelope.parse(await response.json()).data;
    expect(snapshot.name).toBe("l1-demo");
    expect(snapshot.head.kind).toBe("attached");
    expect(
      snapshot.branches.filter((branch) => branch.kind === "local"),
    ).toHaveLength(2);
    expect(
      snapshot.branches.filter((branch) => branch.kind === "remote"),
    ).toHaveLength(3);
    expect(
      snapshot.branches.some((branch) => branch.name === "origin/HEAD"),
    ).toBe(false);
    expect(
      snapshot.remotes.find((remote) => remote.name === "github")?.github,
    ).toEqual({ owner: "l1-family", repo: "l1-git" });
    const remote = snapshotEnvelope.parse(
      await (
        await post("snapshot", {
          path: fixture.repository,
          reference: "refs/remotes/origin/feat/remote-inspector",
        })
      ).json(),
    ).data;
    expect(remote.commits[0]?.subject).toBe(
      "feat(inspector): show commit message and changed paths",
    );
    expect(remote.head).toEqual(snapshot.head);
    const inspector = remote.commits[0];
    if (!inspector) throw new Error("Fixture remote commit is missing");
    const inspectorDetail = z
      .object({ ok: z.literal(true), data: detailSchema })
      .parse(
        await (
          await post("commit-detail", {
            path: fixture.repository,
            oid: inspector.oid,
          })
        ).json(),
      ).data;
    expect(inspectorDetail.files).toEqual([
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
    const detail = z.object({ ok: z.literal(true), data: detailSchema }).parse(
      await (
        await post("commit-detail", {
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

  it("reports empty, detached, bare, and missing states through the same contract", async () => {
    const unborn = snapshotEnvelope.parse(
      await (await post("snapshot", { path: fixture.unborn })).json(),
    ).data;
    expect(unborn.head).toEqual({
      kind: "unborn",
      reference: "refs/heads/main",
    });
    expect(unborn.commits).toEqual([]);
    const detached = snapshotEnvelope.parse(
      await (await post("snapshot", { path: fixture.detached })).json(),
    ).data;
    expect(detached.head.kind).toBe("detached");
    expect(detached.root).not.toBe(unborn.root);
    const failure = z.object({
      ok: z.literal(false),
      error: repositoryErrorSchema,
    });
    expect(
      failure.parse(
        await (await post("snapshot", { path: fixture.remote })).json(),
      ).error.kind,
    ).toBe("bareRepository");
    expect(
      failure.parse(
        await (
          await post("snapshot", { path: `${fixture.root}/missing` })
        ).json(),
      ).error.kind,
    ).toBe("missingPath");
  });

  it("rejects other origins, absent origins, unknown commands, and malformed requests", async () => {
    for (const requestOrigin of [
      null,
      "https://example.test",
      "http://127.0.0.1:9999",
    ]) {
      const response = await post(
        "snapshot",
        { path: fixture.repository },
        requestOrigin,
      );
      expect(response.status).toBe(403);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
    expect((await post("checkout", {})).status).toBe(404);
    expect(
      (await post("snapshot", { path: fixture.repository, unexpected: true }))
        .status,
    ).toBe(400);
  });
});
