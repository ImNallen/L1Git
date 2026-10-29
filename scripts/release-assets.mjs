import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  copyFileSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import {
  compareVersions,
  parseVersion,
  validatePlan,
} from "./release-plan.mjs";

import {
  TARGETS,
  PUBLIC_KEY,
  buildManifest,
  bundleName,
} from "./updater-manifest.mjs";
export { TARGETS } from "./updater-manifest.mjs";

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function active(plan) {
  validatePlan(plan);
  if (plan.action === "skip") throw new Error("A skipped plan has no assets.");
}

export function githubApi(
  endpoint,
  { method, data, paginate = false, binary = false } = {},
) {
  const args = ["api", endpoint];
  if (method) args.push("--method", method);
  if (paginate) args.push("--paginate", "--slurp");
  if (binary) args.push("-H", "Accept: application/octet-stream");
  if (data) args.push("--input", "-");
  const output = execFileSync("gh", args, {
    input: data ? JSON.stringify(data) : undefined,
    encoding: binary ? undefined : "utf8",
    maxBuffer: 1024 * 1024 * 1024,
  });
  return binary ? output : output.trim() ? JSON.parse(output) : null;
}

export async function restoreArtifact(
  name,
  directory,
  env = process.env,
  api = githubApi,
) {
  const base = `repos/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}/artifacts`;
  const pages = await api(`${base}?per_page=100`, { paginate: true });
  const matches = pages
    .flatMap((page) => page.artifacts)
    .filter((artifact) => artifact.name === name);
  if (!matches.length) {
    if (name.startsWith("bundles-") && Number(env.GITHUB_RUN_ATTEMPT) > 1) {
      const jobs = await api(
        `repos/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}/jobs?filter=all&per_page=100`,
        { paginate: true },
      );
      if (
        jobs
          .flatMap((page) => page.jobs)
          .some(
            (job) =>
              job.name === `Build ${name.slice("bundles-".length)}` &&
              job.conclusion === "success",
          )
      ) {
        throw new Error(
          `Successful build artifact ${name} is missing. Start a new run; do not rebuild signed assets in this run.`,
        );
      }
    }
    return false;
  }
  if (matches.length !== 1 || matches[0].expired)
    throw new Error(
      `Artifact ${name} is duplicate or expired. Start a new run.`,
    );
  const archive = await api(
    `repos/${env.GITHUB_REPOSITORY}/actions/artifacts/${matches[0].id}/zip`,
    { binary: true },
  );
  const scratch = mkdtempSync(join(tmpdir(), "l1git-artifact-"));
  try {
    const zip = join(scratch, "artifact.zip");
    writeFileSync(zip, archive);
    mkdirSync(directory, { recursive: true });
    execFileSync("unzip", ["-q", zip, "-d", directory]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return true;
}

function files(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`Unexpected symlink ${path}.`);
    return stat.isDirectory() ? files(path) : [path];
  });
}

function assetName(plan, target, extension) {
  return bundleName(plan.release.version, target, extension);
}

export function stageAssets(plan, targetId, directory, output) {
  active(plan);
  const target = TARGETS.find((entry) => entry.id === targetId);
  if (!target) throw new Error(`Unknown target ${targetId}.`);
  // Do not descend into an app bundle, which legitimately contains symlinks.
  const bundles = [];
  function discover(path) {
    for (const name of readdirSync(path)) {
      const child = join(path, name);
      if (name.endsWith(".app") || name.endsWith(".AppDir")) continue;
      const stat = lstatSync(child);
      if (stat.isSymbolicLink())
        throw new Error(`Unexpected bundle symlink ${child}.`);
      if (stat.isDirectory()) discover(child);
      else if (target.extensions.some((ext) => name.endsWith(`.${ext}`)))
        bundles.push(child);
    }
  }
  discover(directory);
  mkdirSync(output, { recursive: true });
  const assets = target.extensions.map((extension) => {
    const matches = bundles.filter((path) => path.endsWith(`.${extension}`));
    if (matches.length !== 1)
      throw new Error(
        `Expected one ${targetId} .${extension}, found ${matches.length}.`,
      );
    const bytes = readFileSync(matches[0]);
    if (!bytes.length) throw new Error(`Empty bundle ${matches[0]}.`);
    const name = assetName(plan, target, extension);
    copyFileSync(matches[0], join(output, name));
    return {
      name,
      target: target.id,
      size: bytes.length,
      sha256: digest(bytes),
    };
  });
  const manifest = { release: plan.release, target: target.id, assets };
  writeFileSync(join(output, `${target.id}.json`), json(manifest));
  return manifest;
}

export function verifyAssets(
  plan,
  directory,
  publicKey = PUBLIC_KEY,
  repository = "ImNallen/L1Git",
) {
  active(plan);
  const paths = files(directory);
  const expected = new Set();
  const assets = [];
  for (const target of TARGETS) {
    const manifestName = `${target.id}.json`;
    const manifestPaths = paths.filter(
      (path) => basename(path) === manifestName,
    );
    if (manifestPaths.length !== 1)
      throw new Error(`Missing or duplicate ${manifestName}.`);
    expected.add(manifestName);
    const manifest = JSON.parse(readFileSync(manifestPaths[0], "utf8"));
    if (
      !same(manifest.release, plan.release) ||
      manifest.target !== target.id ||
      manifest.assets?.length !== target.extensions.length
    )
      throw new Error(`Artifact metadata conflicts for ${target.id}.`);
    for (const extension of target.extensions) {
      const name = assetName(plan, target, extension);
      expected.add(name);
      const entries = manifest.assets.filter(
        (entry) => entry.name === name && entry.target === target.id,
      );
      const matches = paths.filter((path) => basename(path) === name);
      if (entries.length !== 1 || matches.length !== 1)
        throw new Error(`Missing or duplicate asset ${name}.`);
      const bytes = readFileSync(matches[0]);
      const entry = entries[0];
      if (
        !bytes.length ||
        entry.size !== bytes.length ||
        entry.sha256 !== digest(bytes)
      )
        throw new Error(`Asset hash or size mismatch for ${name}.`);
      assets.push({ ...entry, path: matches[0] });
    }
  }
  if (paths.some((path) => !expected.has(basename(path))))
    throw new Error("Unexpected files in bundle artifacts.");
  assets.sort((a, b) => a.name.localeCompare(b.name));
  const manifest = {
    release: plan.release,
    assets: assets.map(({ path: _path, ...entry }) => entry),
  };
  const feed = buildManifest({
    repository,
    plan,
    publicKey,
    files: Object.fromEntries(
      assets.map((asset) => [asset.name, readFileSync(asset.path)]),
    ),
  });
  return { manifest, assets, feed };
}

export async function publishRelease(
  plan,
  directory,
  remote,
  { publicKey = PUBLIC_KEY, repository = "ImNallen/L1Git" } = {},
) {
  if (plan.action !== "publish")
    throw new Error("Only a publish plan may write a release.");
  const { manifest, assets, feed } = verifyAssets(
    plan,
    directory,
    publicKey,
    repository,
  );
  const manifestBytes = Buffer.from(json(manifest));
  const feedBytes = Buffer.from(json(feed));
  const uploads = [
    ...assets.map((entry) => ({ ...entry, bytes: readFileSync(entry.path) })),
    {
      name: "latest.json",
      bytes: feedBytes,
      size: feedBytes.length,
      sha256: digest(feedBytes),
    },
    {
      name: "release-manifest.json",
      size: manifestBytes.length,
      sha256: digest(manifestBytes),
      bytes: manifestBytes,
    },
  ];
  const r = plan.release;
  const marker = `<!-- l1git-source:${r.sha} -->`;
  const tag = await remote.commitOf(r.tag);
  if (tag && tag !== r.sha)
    throw new Error(`Tag ${r.tag} points at another commit.`);
  let release = await remote.findRelease(r.tag);
  if (r.channel === "stable" && release?.draft !== false) {
    const version = parseVersion(r.version);
    const newer = (await remote.stableTags()).find((tag) => {
      const published = parseVersion(tag.slice(1));
      return (
        published &&
        !published.nightly &&
        compareVersions(published, version) >= 0
      );
    });
    if (newer)
      throw new Error(
        `Stable ${r.tag} would not advance ${newer}. Start a new release attempt.`,
      );
  }
  if (!release) {
    const notes = await remote.notes(r);
    release = await remote.create({
      tag_name: r.tag,
      target_commitish: r.sha,
      name: `L1 Git ${r.tag}`,
      body: `${marker}\n${r.promotedFrom ? `Promoted from ${r.promotedFrom.tag}.\n` : ""}\n${notes}`,
      draft: true,
      prerelease: r.channel === "nightly",
    });
  }
  if (
    release.tag_name !== r.tag ||
    release.target_commitish !== r.sha ||
    !release.body?.includes(marker) ||
    release.prerelease !== (r.channel === "nightly")
  )
    throw new Error("Existing release identity conflicts with the plan.");
  const names = release.assets.map((entry) => entry.name);
  if (
    new Set(names).size !== names.length ||
    names.some((name) => !uploads.some((entry) => entry.name === name))
  )
    throw new Error("Unexpected or duplicate remote assets.");
  for (const upload of uploads) {
    let asset = release.assets.find((entry) => entry.name === upload.name);
    if (!asset) {
      if (!release.draft)
        throw new Error(`Published release is missing ${upload.name}.`);
      asset = await remote.upload(release, upload);
    }
    const bytes = await remote.download(asset);
    if (
      asset.state !== "uploaded" ||
      asset.size !== upload.size ||
      bytes.length !== upload.size ||
      digest(bytes) !== upload.sha256
    )
      throw new Error(
        `Remote bytes conflict for ${upload.name}. Assets are never overwritten.`,
      );
  }
  // A failed publish response is recovered by verifying this same published release on rerun.
  if (release.draft) await remote.publish(release.id, r.channel);
  const published = await remote.findRelease(r.tag);
  if (
    !published ||
    published.draft ||
    published.prerelease !== (r.channel === "nightly") ||
    (await remote.commitOf(r.tag)) !== r.sha
  )
    throw new Error("Publication or tag verification failed.");
  await reconcileNightlyFeed(plan, feedBytes, remote);
  return published;
}

export async function reconcileNightlyFeed(plan, bytes, remote) {
  const marker = "<!-- l1git-nightly-feed -->";
  let feed = await remote.findRelease("nightly");
  if (!feed)
    feed = await remote.create({
      tag_name: "nightly",
      target_commitish: plan.release.sha,
      name: "Nightly update feed",
      body: `${marker}\nStable and nightly releases update latest.json here. Download installers from versioned releases.`,
      draft: false,
      prerelease: true,
      make_latest: "false",
    });
  if (
    feed.draft ||
    !feed.prerelease ||
    !feed.body?.includes(marker) ||
    feed.assets.some((asset) => asset.name !== "latest.json") ||
    feed.assets.length > 1
  )
    throw new Error("Conflicting nightly feed release.");
  const existing = feed.assets[0];
  if (existing) {
    const previous = await remote.download(existing);
    if (existing.state !== "uploaded" || existing.size !== previous.length)
      throw new Error("Existing nightly feed metadata conflicts.");
    const version = parseVersion(JSON.parse(previous.toString("utf8")).version);
    if (!version) throw new Error("Invalid existing nightly feed version.");
    const order = compareVersions(version, parseVersion(plan.release.version));
    if (order > 0) return;
    if (order === 0) {
      if (!previous.equals(bytes))
        throw new Error(
          "Same-version nightly feed conflicts with the release.",
        );
      return;
    }
    await remote.deleteAsset(existing.id);
  }
  const asset = await remote.upload(feed, {
    name: "latest.json",
    size: bytes.length,
    bytes,
  });
  const served = await remote.download(asset);
  if (
    asset.state !== "uploaded" ||
    asset.size !== bytes.length ||
    !served.equals(bytes)
  )
    throw new Error("Nightly feed upload verification failed.");
}

export function githubRemote(
  repo = process.env.GITHUB_REPOSITORY,
  api = githubApi,
) {
  const base = `repos/${repo}`;
  return {
    async commitOf(tag) {
      // Listing refs avoids treating authorization, rate-limit or network failures as a missing tag.
      const pages = await api(
        `${base}/git/matching-refs/tags/${encodeURIComponent(tag)}`,
        { paginate: true },
      );
      let object = pages
        .flat()
        .find((ref) => ref.ref === `refs/tags/${tag}`)?.object;
      if (!object) return null;
      for (let depth = 0; object.type === "tag" && depth < 10; depth++)
        object = (await api(`${base}/git/tags/${object.sha}`)).object;
      if (object.type !== "commit")
        throw new Error("Tag does not resolve to a commit.");
      return object.sha;
    },
    async findRelease(tag) {
      const pages = await api(`${base}/releases?per_page=100`, {
        paginate: true,
      });
      const matches = pages.flat().filter((entry) => entry.tag_name === tag);
      if (matches.length > 1) throw new Error("Duplicate release tags.");
      if (!matches.length) return null;
      const release = matches[0];
      release.assets = (
        await api(`${base}/releases/${release.id}/assets?per_page=100`, {
          paginate: true,
        })
      ).flat();
      return release;
    },
    async stableTags() {
      const pages = await api(`${base}/releases?per_page=100`, {
        paginate: true,
      });
      return pages
        .flat()
        .filter(
          (release) =>
            !release.draft &&
            release.published_at &&
            release.tag_name.startsWith("v"),
        )
        .map((release) => release.tag_name);
    },
    async notes(r) {
      return (
        await api(`${base}/releases/generate-notes`, {
          method: "POST",
          data: {
            tag_name: r.tag,
            target_commitish: r.sha,
            ...(r.previousTag ? { previous_tag_name: r.previousTag } : {}),
          },
        })
      ).body;
    },
    create: (data) => api(`${base}/releases`, { method: "POST", data }),
    async upload(release, upload) {
      const scratch = mkdtempSync(join(tmpdir(), "l1git-upload-"));
      try {
        const path = join(scratch, upload.name);
        writeFileSync(path, upload.bytes);
        const output = execFileSync(
          "gh",
          [
            "api",
            `https://uploads.github.com/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(upload.name)}`,
            "--method",
            "POST",
            "-H",
            "Content-Type: application/octet-stream",
            "--input",
            path,
          ],
          { encoding: "utf8" },
        );
        return JSON.parse(output);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    },
    deleteAsset: (id) =>
      api(`${base}/releases/assets/${id}`, { method: "DELETE" }),
    download: (asset) =>
      api(`${base}/releases/assets/${asset.id}`, { binary: true }),
    publish: (id, channel) =>
      api(`${base}/releases/${id}`, {
        method: "PATCH",
        data: {
          draft: false,
          make_latest: channel === "stable" ? "true" : "false",
        },
      }),
  };
}

async function main() {
  const [command, planPath, ...args] = process.argv.slice(2);
  if (command === "restore") {
    const restored = await restoreArtifact(planPath, args[0]);
    if (restored) {
      const plan = args[1] ? JSON.parse(readFileSync(args[1], "utf8")) : null;
      const target = TARGETS.find(
        (entry) => `bundles-${entry.id}` === planPath,
      );
      if (!target && planPath !== "dry-run-signing")
        throw new Error("Unknown artifact target.");
      if (planPath === "dry-run-signing") {
        if (process.env.GITHUB_OUTPUT)
          writeFileSync(process.env.GITHUB_OUTPUT, "restored=true\n", {
            flag: "a",
          });
        return;
      }
      // Completeness across targets is checked after all builds finish.
      const metadata = JSON.parse(
        readFileSync(join(args[0], `${target.id}.json`), "utf8"),
      );
      if (!same(metadata.release, plan.release))
        throw new Error("Restored artifact belongs to another plan.");
    }
    if (process.env.GITHUB_OUTPUT)
      writeFileSync(process.env.GITHUB_OUTPUT, `restored=${restored}\n`, {
        flag: "a",
      });
    return;
  }
  const plan = JSON.parse(readFileSync(planPath, "utf8"));
  if (command === "stage") stageAssets(plan, args[0], args[1], args[2]);
  else if (command === "verify") {
    const publicKey = process.env.UPDATER_PUBKEY_FILE
      ? readFileSync(process.env.UPDATER_PUBKEY_FILE, "utf8").trim()
      : PUBLIC_KEY;
    const { manifest, feed } = verifyAssets(
      plan,
      args[0],
      publicKey,
      process.env.GITHUB_REPOSITORY,
    );
    writeFileSync("latest.json", json(feed));
    writeFileSync(args[1] ?? "release-manifest.json", json(manifest));
    console.log(json(manifest));
  } else if (command === "publish") {
    const release = await publishRelease(plan, args[0], githubRemote());
    console.log(release.html_url);
  } else throw new Error(`Unknown command ${command}.`);
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
