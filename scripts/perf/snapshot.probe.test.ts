import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, it } from "vitest";
import { buildGraph } from "../../src/domain/graph";
import { refLabels } from "../../src/domain/refs";
import {
  snapshotSchema,
  worktreeStatusSchema,
} from "../../src/domain/repository";
import { historyRows } from "../../src/domain/worktree";

const repos = (process.env.L1GIT_PERF_REPOS ?? "").split(",").filter(Boolean);
const runs = Number(process.env.L1GIT_PERF_RUNS ?? 7);
const bridges = (
  process.env.L1GIT_PERF_BRIDGES ??
  `bridge=${process.env.L1GIT_PERF_BRIDGE ?? "http://127.0.0.1:9499"}`
)
  .split(",")
  .filter(Boolean)
  .map((pair) => {
    const at = pair.indexOf("=");
    return { name: pair.slice(0, at), url: pair.slice(at + 1) };
  });
const bridge = bridges[0]!.url;
const origin = process.env.L1GIT_PERF_ORIGIN ?? "http://127.0.0.1:1499";
const out = process.env.L1GIT_PERF_OUT ?? "/tmp/l1perf/snapshot.json";
const statusOut =
  process.env.L1GIT_PERF_STATUS_OUT ?? "/tmp/l1perf/status.json";
const repeats = Number(process.env.L1GIT_PERF_STATUS_READS ?? 5);
const pauseMs = Number(process.env.L1GIT_PERF_PAUSE_MS ?? 0);
const afterFirstMs = Number(process.env.L1GIT_PERF_AFTER_FIRST_MS ?? 1000);
const settleMs = Number(process.env.L1GIT_PERF_SETTLE_MS ?? 2000);
const copies = process.env.L1GIT_PERF_COPIES ?? "/tmp/l1perf/copies.noindex";

type Sample = Record<string, number>;

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function spread(values: number[]) {
  const round = (value: number) => Math.round(value * 10) / 10;
  return {
    median: round(median(values)),
    min: round(Math.min(...values)),
    max: round(Math.max(...values)),
  };
}

function time<T>(f: () => T): [T, number] {
  const start = performance.now();
  const value = f();
  return [value, performance.now() - start];
}

function gitLog(repo: string) {
  const start = performance.now();
  const result = spawnSync(
    "git",
    [
      "-C",
      repo,
      "log",
      "--topo-order",
      "--format=%H%x00%P%x00%s%x00%an%x00%ae%x00%at",
      "-z",
      "--max-count=50001",
      "--branches",
      "--remotes",
      "--tags",
      "HEAD",
      "--",
    ],
    { maxBuffer: 1 << 30 },
  );
  if (result.status !== 0) throw new Error(String(result.stderr));
  return performance.now() - start;
}

async function sample(repo: string): Promise<Sample> {
  const start = performance.now();
  const response = await fetch(`${bridge}/api/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ op: "snapshot", path: repo }),
  });
  const text = await response.text();
  const request = performance.now() - start;
  if (!response.ok) throw new Error(`snapshot failed: ${text.slice(0, 500)}`);
  const [json, jsonParse] = time(() => JSON.parse(text));
  if (json.op !== "snapshot") throw new Error(`unexpected op ${json.op}`);
  const [snapshot, zodParse] = time(() => snapshotSchema.parse(json.data));
  const [rows, rowsMs] = time(() =>
    historyRows(snapshot.commits, snapshot.worktrees, new Map()),
  );
  const [graph, graphMs] = time(() => buildGraph(rows, snapshot.squashes));
  const [, labelsMs] = time(() => refLabels(snapshot));
  if (graph.rows.size !== snapshot.commits.length)
    throw new Error("graph lost rows");
  return {
    request,
    jsonParse,
    zodParse,
    rowsMs,
    graphMs,
    labelsMs,
    frontend: jsonParse + zodParse + rowsMs + graphMs + labelsMs,
    total: request + jsonParse + zodParse + rowsMs + graphMs + labelsMs,
    gitLog: gitLog(repo),
    bytes: text.length,
    commits: snapshot.commits.length,
    squashes: snapshot.squashes.length,
    lanes: graph.lanes,
  };
}

describe.skipIf(repos.length === 0)("snapshot refresh probe", () => {
  it(
    "times a focus refresh per repository",
    async () => {
      const samples = new Map<string, Sample[]>(repos.map((r) => [r, []]));
      for (const repo of repos) await sample(repo);
      for (let i = 0; i < runs; i++)
        for (const repo of repos) samples.get(repo)!.push(await sample(repo));
      const report = Object.fromEntries(
        [...samples].map(([repo, list]) => [
          repo,
          Object.fromEntries(
            Object.keys(list[0]!).map((key) => {
              const values = list.map((s) => s[key]!);
              return [
                key,
                {
                  median: Math.round(median(values) * 10) / 10,
                  min: Math.round(Math.min(...values) * 10) / 10,
                  max: Math.round(Math.max(...values) * 10) / 10,
                },
              ];
            }),
          ),
        ]),
      );
      writeFileSync(out, JSON.stringify({ runs, report }, null, 2));
      console.log(JSON.stringify(report, null, 2));
    },
    30 * 60_000,
  );
});

async function statusRead(url: string, repo: string) {
  const start = performance.now();
  const response = await fetch(`${url}/api/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ op: "worktreeStatus", path: repo }),
  });
  const text = await response.text();
  const ms = performance.now() - start;
  if (!response.ok) throw new Error(`status failed: ${text.slice(0, 500)}`);
  const json = JSON.parse(text);
  if (json.op !== "worktreeStatus") throw new Error(`unexpected op ${json.op}`);
  return { ms, entries: worktreeStatusSchema.parse(json.data).entries };
}

/** Index entries whose cached stat data no longer matches the file. */
function staleEntries(repo: string) {
  const result = spawnSync(
    "git",
    ["-C", repo, "diff-files", "--name-only", "-z", "--ignore-submodules"],
    { env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, maxBuffer: 1 << 30 },
  );
  if (result.status !== 0) throw new Error(String(result.stderr));
  return result.stdout.toString().split("\0").filter(Boolean).length;
}

/** A fresh `cp -R` of `repo` keeps the old index, so every entry is stale. */
async function staleCopyRun(url: string, repo: string, copy: string) {
  rmSync(copy, { recursive: true, force: true });
  mkdirSync(copies, { recursive: true });
  const copied = spawnSync("cp", ["-R", repo, copy]);
  if (copied.status !== 0) throw new Error(String(copied.stderr));
  await sleep(settleMs);
  const staleBefore = staleEntries(copy);
  const first = await statusRead(url, copy);
  await sleep(afterFirstMs);
  const repeated = [];
  for (let i = 0; i < repeats; i++) {
    if (i > 0) await sleep(pauseMs);
    const read = await statusRead(url, copy);
    if (JSON.stringify(read.entries) !== JSON.stringify(first.entries))
      throw new Error(`status changed between reads of ${copy}`);
    repeated.push(read.ms);
  }
  const staleAfter = staleEntries(copy);
  rmSync(copy, { recursive: true, force: true });
  return {
    first: first.ms,
    repeated,
    staleBefore,
    staleAfter,
    entries: first.entries.length,
  };
}

describe.skipIf(repos.length === 0)("worktree status probe", () => {
  it(
    "times the first and repeated status reads of a stale-index copy",
    async () => {
      type Run = Awaited<ReturnType<typeof staleCopyRun>>;
      const results = new Map<string, Run[]>();
      const key = (name: string, repo: string) => `${name} ${repo}`;
      const once = (name: string, url: string, repo: string, run: number) =>
        staleCopyRun(url, repo, `${copies}/${name}-${run}`);
      for (const repo of repos)
        for (const { name, url } of bridges) await once(name, url, repo, -1);
      for (let run = 0; run < runs; run++)
        for (const repo of repos) {
          const order = run % 2 === 0 ? bridges : [...bridges].reverse();
          for (const { name, url } of order) {
            const list = results.get(key(name, repo)) ?? [];
            list.push(await once(name, url, repo, run));
            results.set(key(name, repo), list);
          }
        }
      const report = Object.fromEntries(
        [...results].map(([name, list]) => [
          name,
          {
            first: spread(list.map((run) => run.first)),
            second: spread(list.map((run) => run.repeated[0]!)),
            repeated: spread(list.flatMap((run) => run.repeated)),
            staleBefore: spread(list.map((run) => run.staleBefore)),
            staleAfter: spread(list.map((run) => run.staleAfter)),
            entries: spread(list.map((run) => run.entries)),
          },
        ]),
      );
      writeFileSync(
        statusOut,
        JSON.stringify(
          {
            runs,
            repeats,
            afterFirstMs,
            pauseMs,
            settleMs,
            report,
            raw: [...results],
          },
          null,
          2,
        ),
      );
      console.log(JSON.stringify(report, null, 2));
    },
    60 * 60_000,
  );
});
