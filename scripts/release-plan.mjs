import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { pathToFileURL } from "node:url";

const NIGHTLY_GAP_MS = 6 * 60 * 60 * 1000;
const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-nightly\.(\d{8})\.([1-9]\d*))?$/;
const SHA = /^[a-f0-9]{40}$/;

export function parseVersion(text) {
  const match = VERSION.exec(text);
  if (!match) return null;
  const [, major, minor, patch, date, run] = match;
  const core = [major, minor, patch].map(Number);
  if (
    !core.every(Number.isSafeInteger) ||
    (run && !Number.isSafeInteger(Number(run)))
  )
    return null;
  return {
    text,
    core,
    nightly: date ? { date: Number(date), run: Number(run) } : null,
  };
}

export function compareVersions(a, b) {
  for (let i = 0; i < 3; i++)
    if (a.core[i] !== b.core[i]) return a.core[i] - b.core[i];
  if (!a.nightly || !b.nightly)
    return (a.nightly ? -1 : 0) - (b.nightly ? -1 : 0);
  return a.nightly.date - b.nightly.date || a.nightly.run - b.nightly.run;
}

export function parseReleases(raw) {
  if (!Array.isArray(raw)) throw new Error("Expected a GitHub releases array.");
  return raw.flatMap((release) => {
    if (typeof release.tag_name !== "string")
      throw new Error("Release has no tag_name.");
    const version = release.tag_name.startsWith("v")
      ? parseVersion(release.tag_name.slice(1))
      : null;
    if (!version || release.draft || !release.published_at) return [];
    const publishedAt = new Date(release.published_at);
    if (!Number.isFinite(+publishedAt))
      throw new Error(`Invalid publication date for ${release.tag_name}.`);
    const marker = /<!-- l1git-source:([a-f0-9]{40}) -->/.exec(
      release.body ?? "",
    );
    return [
      { tag: release.tag_name, version, publishedAt, sha: marker?.[1] ?? null },
    ];
  });
}

function latestStable(releases) {
  return (
    releases
      .filter((r) => !r.version.nightly)
      .sort((a, b) => compareVersions(b.version, a.version))[0] ?? null
  );
}

function latestNightly(releases) {
  return (
    releases
      .filter((r) => r.version.nightly)
      .sort((a, b) => b.publishedAt - a.publishedAt)[0] ?? null
  );
}

function recordedCommit(release, git) {
  if (!release.sha)
    throw new Error(`${release.tag} has no recorded source SHA.`);
  if (git.commitOf(release.tag) !== release.sha)
    throw new Error(
      `${release.tag} no longer resolves to its recorded source SHA.`,
    );
  return release.sha;
}

function nightlyRelease(facts) {
  const stable = latestStable(facts.releases);
  const [major, minor, patch] = (
    stable?.version ?? parseVersion(facts.checkedInVersion)
  ).core;
  const date = facts.now.toISOString().slice(0, 10).replaceAll("-", "");
  const version = `${major}.${minor}.${patch + 1}-nightly.${date}.${facts.runNumber}`;
  return {
    channel: "nightly",
    version,
    tag: `v${version}`,
    sha: facts.sha,
    previousTag: latestNightly(facts.releases)?.tag ?? null,
    promotedFrom: null,
  };
}

function stableRelease(facts, version, sha, promotedFrom = null) {
  const parsed = parseVersion(version);
  if (!parsed || parsed.nightly)
    throw new Error(`A stable version is plain X.Y.Z, not ${version}.`);
  const stable = latestStable(facts.releases);
  if (stable && compareVersions(parsed, stable.version) <= 0) {
    throw new Error(
      `Stable ${version} is not newer than the latest stable ${stable.tag}.`,
    );
  }
  return {
    channel: "stable",
    version,
    tag: `v${version}`,
    sha,
    previousTag: stable?.tag ?? null,
    promotedFrom,
  };
}

function choose(facts, git) {
  switch (facts.event) {
    case "pull_request":
      return {
        action: "dry-run",
        release: nightlyRelease(facts),
        reason: "Pull request packaging. Nothing is published.",
      };
    case "schedule": {
      const last = latestNightly(facts.releases);
      if (last) {
        if (facts.now - last.publishedAt < NIGHTLY_GAP_MS)
          return {
            action: "skip",
            reason: `${last.tag} was published less than 6 h ago.`,
          };
        const shipped = recordedCommit(last, git);
        if (shipped === facts.sha)
          return {
            action: "skip",
            reason: `main has no commits since ${last.tag}.`,
          };
        if (!git.isAncestor(shipped, facts.sha))
          throw new Error(`${last.tag} is not an ancestor of main.`);
      }
      return {
        action: "publish",
        release: nightlyRelease(facts),
        reason: "Nightly is due and main has new commits.",
      };
    }
    case "workflow_dispatch": {
      if (facts.ref !== "refs/heads/main")
        throw new Error(
          `Stable and nightly releases run only from main, not ${facts.ref}.`,
        );
      if (facts.channel === "nightly") {
        if (facts.version)
          throw new Error("A version override is only valid for stable.");
        return {
          action: "publish",
          release: nightlyRelease(facts),
          reason: "Manual nightly bypasses cadence.",
        };
      }
      if (facts.channel !== "stable")
        throw new Error(`Unknown channel ${facts.channel}.`);
      const nightly = latestNightly(facts.releases);
      if (!nightly) throw new Error("No published nightly to promote.");
      const sha = recordedCommit(nightly, git);
      if (!git.isAncestor(sha, facts.sha))
        throw new Error(`${nightly.tag} is not on main.`);
      return {
        action: "publish",
        release: stableRelease(
          facts,
          facts.version || nightly.version.core.join("."),
          sha,
          { tag: nightly.tag, sha },
        ),
        reason: `Rebuild the exact source of ${nightly.tag}.`,
      };
    }
    case "push": {
      if (!facts.ref.startsWith("refs/tags/v"))
        throw new Error("A release push must be a vX.Y.Z tag.");
      return {
        action: "publish",
        release: stableRelease(
          facts,
          facts.ref.slice("refs/tags/v".length),
          facts.sha,
        ),
        reason: `Hand-picked tag ${facts.ref}.`,
      };
    }
    default:
      throw new Error(`Release does not handle the ${facts.event} event.`);
  }
}

/** @returns {{action:'skip', reason:string} | {action:'dry-run'|'publish', reason:string, release:object}} */
export function planRelease(facts, git) {
  const plan = choose(facts, git);
  if (plan.action === "skip") return plan;
  const tagged = git.commitOf(plan.release.tag);
  if (tagged && tagged !== plan.release.sha)
    throw new Error(`Tag ${plan.release.tag} points at another commit.`);
  if (facts.releases.some((r) => r.tag === plan.release.tag))
    throw new Error(
      `Release ${plan.release.tag} is already published. Resume its original run.`,
    );
  return plan;
}

export function validatePlan(plan, runId, workflowSha) {
  if (
    !plan ||
    !["skip", "dry-run", "publish"].includes(plan.action) ||
    typeof plan.reason !== "string"
  )
    throw new Error("Invalid release plan.");
  if (plan.action === "skip") {
    if (plan.release) throw new Error("A skipped plan cannot have a release.");
    return plan;
  }
  const r = plan.release;
  const version = r && parseVersion(r.version);
  if (
    !version ||
    !SHA.test(r.sha) ||
    r.tag !== `v${r.version}` ||
    r.channel !== (version.nightly ? "nightly" : "stable")
  )
    throw new Error("Invalid release identity.");
  if (
    !Number.isFinite(Date.parse(r.createdAt)) ||
    !SHA.test(r.workflowSha) ||
    !/^\d+$/.test(r.runId) ||
    (runId && r.runId !== runId) ||
    (workflowSha && r.workflowSha !== workflowSha)
  )
    throw new Error("Plan belongs to another workflow revision or run.");
  if (r.previousTag !== null && !/^v[\w.-]+$/.test(r.previousTag))
    throw new Error("Invalid previous tag.");
  if (
    r.promotedFrom !== null &&
    (!/^v[\w.-]+$/.test(r.promotedFrom?.tag) || r.promotedFrom.sha !== r.sha)
  )
    throw new Error("Invalid promotion source.");
  return plan;
}

export function formatOutputs(plan, targets) {
  const r = plan.release ?? {};
  return Object.entries({
    action: plan.action,
    version: r.version ?? "",
    sha: r.sha ?? "",
    matrix: JSON.stringify({ include: targets }),
  })
    .map(([key, value]) => `${key}=${value}\n`)
    .join("");
}

export const localGit = {
  commitOf(tag) {
    try {
      return execFileSync(
        "git",
        ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`],
        { encoding: "utf8" },
      ).trim();
    } catch (error) {
      if (error.status === 1) return null;
      throw error;
    }
  },
  isAncestor(a, b) {
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", a, b]);
      return true;
    } catch (error) {
      if (error.status === 1) return false;
      throw error;
    }
  },
};

export async function resolvePlan(env, api, restore) {
  if (await restore("release-plan", ".release-plan")) {
    return validatePlan(
      JSON.parse(readFileSync(".release-plan/plan.json", "utf8")),
      env.GITHUB_RUN_ID,
      env.WORKFLOW_SHA ?? env.GITHUB_SHA,
    );
  }
  if (Number(env.GITHUB_RUN_ATTEMPT) > 1)
    throw new Error(
      "The original plan artifact is missing or expired. Start a new run; do not replan this run.",
    );
  const raw =
    env.GITHUB_EVENT_NAME === "pull_request"
      ? []
      : (
          await api(`repos/${env.GITHUB_REPOSITORY}/releases?per_page=100`, {
            paginate: true,
          })
        ).flat();
  const facts = {
    event: env.GITHUB_EVENT_NAME,
    ref: env.GITHUB_REF,
    sha: env.RELEASE_SHA,
    channel: env.INPUT_CHANNEL,
    version: env.INPUT_VERSION,
    runNumber: Number(env.GITHUB_RUN_NUMBER),
    now: new Date(env.RUN_STARTED_AT),
    checkedInVersion: JSON.parse(
      readFileSync("src-tauri/tauri.conf.json", "utf8"),
    ).version,
    releases: parseReleases(raw),
  };
  if (
    !SHA.test(facts.sha) ||
    !Number.isSafeInteger(facts.runNumber) ||
    facts.runNumber < 1 ||
    !Number.isFinite(+facts.now)
  )
    throw new Error("Invalid run facts.");
  const plan = planRelease(facts, localGit);
  if (plan.release)
    Object.assign(plan.release, {
      runId: env.GITHUB_RUN_ID,
      workflowSha: env.WORKFLOW_SHA ?? env.GITHUB_SHA,
      createdAt: facts.now.toISOString(),
    });
  return validatePlan(
    plan,
    env.GITHUB_RUN_ID,
    env.WORKFLOW_SHA ?? env.GITHUB_SHA,
  );
}

async function main() {
  const { githubApi, restoreArtifact, TARGETS } =
    await import("./release-assets.mjs");
  const plan = await resolvePlan(process.env, githubApi, restoreArtifact);
  writeFileSync("plan.json", `${JSON.stringify(plan, null, 2)}\n`);
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    formatOutputs(plan, TARGETS) +
      `restored=${existsSync(".release-plan/plan.json")}\n`,
  );
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `${plan.action}: ${plan.reason}\n`,
    );
  console.log(JSON.stringify(plan, null, 2));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
