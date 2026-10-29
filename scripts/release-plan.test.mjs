import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareVersions,
  formatOutputs,
  parseReleases,
  parseVersion,
  planRelease,
  resolvePlan,
  validatePlan,
} from "./release-plan.mjs";

const sha = (n) => String(n).repeat(40);
const tags = { "v0.1.4": sha(1), "v0.1.5-nightly.20261022.9": sha(3) };
const git = (overrides = {}) => ({
  commitOf: (tag) => ({ ...tags, ...overrides })[tag] ?? null,
  isAncestor: (a, b) => a <= b,
});
const release = (tag, date, source = sha(3), extra = {}) => ({
  tag_name: tag,
  draft: false,
  published_at: date,
  body: `<!-- l1git-source:${source} -->`,
  ...extra,
});
const history = () =>
  parseReleases([
    release("nightly", "2026-10-22T09:00:00Z"),
    release("v0.1.5-nightly.20261022.9", "2026-10-22T09:00:00Z"),
    release("v0.1.4", "2026-10-19T09:00:00Z", sha(1)),
    release("v0.1.9", null, sha(1), { draft: true }),
  ]);
const facts = (overrides = {}) => ({
  event: "schedule",
  ref: "refs/heads/main",
  sha: sha(4),
  channel: "",
  version: "",
  runNumber: 42,
  now: new Date("2026-10-23T08:30:00Z"),
  checkedInVersion: "0.1.0",
  releases: history(),
  ...overrides,
});

const activePlan = () => ({
  ...planRelease(facts(), git()),
  release: {
    ...planRelease(facts(), git()).release,
    workflowSha: sha(4),
    runId: "100",
  },
});

test("scheduled nightly uses the next stable patch, UTC date and run number", () => {
  const plan = planRelease(facts(), git());
  assert.equal(plan.action, "publish");
  assert.deepEqual(plan.release, {
    channel: "nightly",
    version: "0.1.5-nightly.20261023.42",
    tag: "v0.1.5-nightly.20261023.42",
    sha: sha(4),
    previousTag: "v0.1.5-nightly.20261022.9",
    promotedFrom: null,
  });
  assert.equal(
    planRelease(facts({ releases: [] }), git()).release.version,
    "0.1.1-nightly.20261023.42",
  );
});

test("schedule requires at least six hours and new main commits", () => {
  assert.equal(planRelease(facts({ sha: sha(3) }), git()).action, "skip");
  const recent = facts({ now: new Date("2026-10-22T14:59:59Z") });
  assert.equal(planRelease(recent, git()).action, "skip");
  assert.equal(
    planRelease({ ...recent, now: new Date("2026-10-22T15:00:00Z") }, git())
      .action,
    "publish",
  );
  assert.throws(
    () => planRelease(facts(), { ...git(), isAncestor: () => false }),
    /not an ancestor/,
  );
});

test("manual nightly bypasses cadence and requires main", () => {
  const manual = facts({
    event: "workflow_dispatch",
    channel: "nightly",
    sha: sha(3),
    now: new Date("2026-10-22T10:00:00Z"),
  });
  assert.equal(planRelease(manual, git()).action, "publish");
  assert.throws(
    () => planRelease({ ...manual, ref: "refs/heads/feature" }, git()),
    /only from main/,
  );
  assert.throws(
    () => planRelease({ ...manual, version: "0.2.0" }, git()),
    /only valid for stable/,
  );
});

test("stable rebuilds the latest nightly's recorded exact source", () => {
  const stable = facts({ event: "workflow_dispatch", channel: "stable" });
  const plan = planRelease(stable, git());
  assert.equal(plan.release.sha, sha(3));
  assert.equal(plan.release.version, "0.1.5");
  assert.deepEqual(plan.release.promotedFrom, {
    tag: "v0.1.5-nightly.20261022.9",
    sha: sha(3),
  });
  assert.equal(
    planRelease({ ...stable, version: "0.2.0" }, git()).release.tag,
    "v0.2.0",
  );
  for (const version of [
    "v0.2.0",
    "0.1.4",
    "0.2.0-rc.1",
    "0.2.0-nightly.20261023.1",
  ])
    assert.throws(() => planRelease({ ...stable, version }, git()));
  assert.throws(
    () => planRelease({ ...stable, releases: [] }, git()),
    /No published nightly/,
  );
  assert.throws(
    () => planRelease(stable, git({ "v0.1.5-nightly.20261022.9": sha(2) })),
    /no longer resolves/,
  );
  assert.throws(
    () => planRelease(stable, { ...git(), isAncestor: () => false }),
    /not on main/,
  );
  assert.throws(
    () =>
      planRelease(
        {
          ...stable,
          releases: parseReleases([
            release("v0.1.5-nightly.20261022.9", "2026-10-22T09:00:00Z", ""),
          ]),
        },
        git(),
      ),
    /no recorded source/,
  );
});

test("tag pushes can hand-pick a non-main commit but stable versions must increase", () => {
  const pushed = facts({ event: "push", ref: "refs/tags/v0.1.6", sha: sha(9) });
  assert.equal(
    planRelease(pushed, git({ "v0.1.6": sha(9) })).release.sha,
    sha(9),
  );
  assert.throws(
    () => planRelease({ ...pushed, ref: "refs/tags/v0.1.4" }, git()),
    /not newer/,
  );
  assert.throws(
    () => planRelease(pushed, git({ "v0.1.6": sha(2) })),
    /another commit/,
  );
  assert.throws(
    () =>
      planRelease(
        { ...pushed, ref: "refs/tags/v0.1.6-nightly.20261023.1" },
        git(),
      ),
    /plain X.Y.Z/,
  );
});

test("PR packaging plans a nightly without published history", () => {
  const plan = planRelease(
    facts({ event: "pull_request", releases: [] }),
    git(),
  );
  assert.equal(plan.action, "dry-run");
  assert.equal(plan.release.sha, sha(4));
});

test("version ordering and release parsing exclude drafts and unrelated tags", () => {
  const versions = [
    "0.1.5",
    "0.1.5-nightly.20261022.10",
    "0.1.4",
    "0.1.5-nightly.20261022.9",
  ];
  assert.deepEqual(
    versions
      .map(parseVersion)
      .sort(compareVersions)
      .map((v) => v.text),
    [versions[2], versions[3], versions[1], versions[0]],
  );
  assert.equal(parseVersion("01.1.5"), null);
  assert.equal(parseVersion("9007199254740992.1.5"), null);
  assert.equal(history().length, 2);
  assert.throws(() => parseReleases({ message: "API failure" }));
  assert.throws(() => parseReleases([release("v0.1.4", "invalid")]));
});

test("persisted plan validation rejects identity and provenance mismatches", () => {
  const plan = activePlan();
  assert.equal(validatePlan(plan, "100", sha(4)), plan);
  assert.throws(() => validatePlan(plan, "101", sha(4)), /another workflow/);
  assert.throws(() => validatePlan(plan, "100", sha(5)), /another workflow/);
  assert.throws(
    () => validatePlan({ ...plan, release: { ...plan.release, tag: "wrong" } }),
    /Invalid release identity/,
  );
  assert.throws(() =>
    validatePlan({ action: "skip", reason: "x", release: plan.release }),
  );
  assert.match(
    formatOutputs(plan, [{ id: "macos-universal" }]),
    /matrix={"include":\[{"id":"macos-universal"}\]}/,
  );
});

test("full rerun restores the original plan before mutable history, including across midnight", async () => {
  const dir = mkdtempSync(join(tmpdir(), "l1git-plan-"));
  const previous = process.cwd();
  process.chdir(dir);
  try {
    mkdirSync(".release-plan");
    const original = activePlan();
    writeFileSync(".release-plan/plan.json", JSON.stringify(original));
    const env = {
      GITHUB_RUN_ID: "100",
      GITHUB_SHA: sha(4),
      GITHUB_RUN_ATTEMPT: "2",
      RUN_STARTED_AT: "2026-10-24T01:00:00Z",
    };
    const restored = await resolvePlan(
      env,
      () => {
        throw new Error("History must not be read");
      },
      async () => true,
    );
    assert.deepEqual(restored, original);
    await assert.rejects(
      resolvePlan(
        env,
        () => [],
        async () => false,
      ),
      /missing or expired/,
    );
  } finally {
    process.chdir(previous);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("history API errors fail closed instead of planning a first release", async () => {
  await assert.rejects(
    resolvePlan(
      { GITHUB_RUN_ATTEMPT: "1", GITHUB_REPOSITORY: "ImNallen/L1Git" },
      () => {
        throw new Error("HTTP 403");
      },
      async () => false,
    ),
    /HTTP 403/,
  );
});
