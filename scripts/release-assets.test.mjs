import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  TARGETS,
  githubRemote,
  publishRelease,
  restoreArtifact,
  stageAssets,
  verifyAssets,
} from "./release-assets.mjs";

const sha = "a".repeat(40);
const plan = {
  action: "publish",
  reason: "Test",
  release: {
    channel: "nightly",
    version: "0.1.1-nightly.20261023.42",
    tag: "v0.1.1-nightly.20261023.42",
    sha,
    workflowSha: sha,
    runId: "100",
    previousTag: null,
    promotedFrom: null,
  },
};

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "l1git-assets-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const staged = join(dir, "staged");
  for (const target of TARGETS) {
    const input = join(dir, target.id);
    mkdirSync(input);
    for (const extension of target.extensions)
      writeFileSync(
        join(input, `bundle.${extension}`),
        `package ${target.id} ${extension}`,
      );
    stageAssets(plan, target.id, input, staged);
  }
  return { dir, staged };
}

function fakeRemote() {
  const state = {
    release: null,
    tag: null,
    writes: [],
    bytes: new Map(),
    failAfterUploads: Infinity,
    failAfterPublish: false,
  };
  const remote = {
    commitOf: async () => state.tag,
    findRelease: async () => state.release,
    notes: async () => "Release notes",
    create: async (data) => {
      state.writes.push("create");
      return (state.release = { ...data, id: 1, assets: [] });
    },
    upload: async (_release, upload) => {
      if (state.bytes.size === state.failAfterUploads)
        throw new Error("Upload interrupted");
      state.writes.push(`upload ${upload.name}`);
      const asset = {
        id: state.bytes.size + 1,
        name: upload.name,
        size: upload.size,
      };
      state.bytes.set(asset.id, upload.bytes);
      state.release.assets.push(asset);
      return asset;
    },
    download: async (asset) => state.bytes.get(asset.id),
    publish: async () => {
      state.writes.push("publish");
      state.release.draft = false;
      state.tag = sha;
      if (state.failAfterPublish)
        throw new Error("Response lost after publication");
    },
  };
  return { state, remote };
}

test("registry defines macOS DMG and Linux AppImage/deb, staging verifies every hash", (t) => {
  const { staged } = fixture(t);
  const set = verifyAssets(plan, staged);
  assert.equal(set.assets.length, 3);
  assert.deepEqual(set.manifest.release, plan.release);
  for (const asset of set.assets)
    assert.equal(readFileSync(asset.path).length, asset.size);
});

test("missing, duplicate and unexpected bundles fail completeness", (t) => {
  const { staged, dir } = fixture(t);
  writeFileSync(join(staged, "unexpected.txt"), "x");
  assert.throws(() => verifyAssets(plan, staged), /Unexpected files/);
  rmSync(join(staged, "unexpected.txt"));
  const first = verifyAssets(plan, staged).assets[0];
  mkdirSync(join(staged, "duplicate"));
  writeFileSync(join(staged, "duplicate", first.name), "x");
  assert.throws(() => verifyAssets(plan, staged), /duplicate asset/);
  rmSync(join(staged, "duplicate"), { recursive: true });
  rmSync(first.path);
  assert.throws(() => verifyAssets(plan, staged), /Missing or duplicate asset/);
  const empty = join(dir, "empty");
  mkdirSync(empty);
  assert.throws(
    () => stageAssets(plan, "macos-universal", empty, join(dir, "out")),
    /Expected one/,
  );
  writeFileSync(join(empty, "one.dmg"), "a");
  writeFileSync(join(empty, "two.dmg"), "b");
  assert.throws(
    () => stageAssets(plan, "macos-universal", empty, join(dir, "out")),
    /found 2/,
  );
});

test("artifact metadata must match version, source, target, size and hash", (t) => {
  const { staged } = fixture(t);
  const asset = verifyAssets(plan, staged).assets[0];
  writeFileSync(asset.path, "tampered");
  assert.throws(() => verifyAssets(plan, staged), /hash or size mismatch/);
  assert.throws(
    () =>
      verifyAssets(
        { ...plan, release: { ...plan.release, sha: "b".repeat(40) } },
        staged,
      ),
    /metadata conflicts/,
  );
});

test("partial draft resumes missing uploads using original artifacts", async (t) => {
  const { staged } = fixture(t);
  const { state, remote } = fakeRemote();
  state.failAfterUploads = 1;
  await assert.rejects(
    publishRelease(plan, staged, remote),
    /Upload interrupted/,
  );
  assert.equal(state.release.draft, true);
  const uploaded = state.release.assets[0].name;
  state.failAfterUploads = Infinity;
  await publishRelease(plan, staged, remote);
  assert.equal(state.release.draft, false);
  assert.equal(state.release.assets.length, 4);
  assert.equal(
    state.writes.filter((write) => write === `upload ${uploaded}`).length,
    1,
  );
  assert.equal(state.writes.filter((write) => write === "create").length, 1);
});

test("a lost publish response recovers as matching published success without writes", async (t) => {
  const { staged } = fixture(t);
  const { state, remote } = fakeRemote();
  state.failAfterPublish = true;
  await assert.rejects(publishRelease(plan, staged, remote), /Response lost/);
  const writes = [...state.writes];
  await publishRelease(plan, staged, remote);
  assert.deepEqual(state.writes, writes);
});

test("mismatching remote bytes and rebuilt signed assets are never overwritten", async (t) => {
  const { staged } = fixture(t);
  const { state, remote } = fakeRemote();
  state.failAfterUploads = 1;
  await assert.rejects(publishRelease(plan, staged, remote));
  state.bytes.set(1, Buffer.from("different signed build"));
  const writes = [...state.writes];
  await assert.rejects(
    publishRelease(plan, staged, remote),
    /Remote bytes conflict/,
  );
  assert.deepEqual(state.writes, writes);
});

test("conflicting release/tag or incomplete published release fails", async (t) => {
  const { staged } = fixture(t);
  const { state, remote } = fakeRemote();
  state.tag = "b".repeat(40);
  await assert.rejects(publishRelease(plan, staged, remote), /another commit/);
  state.tag = null;
  await publishRelease(plan, staged, remote);
  state.release.assets.pop();
  await assert.rejects(
    publishRelease(plan, staged, remote),
    /Published release is missing/,
  );
  state.release.target_commitish = "main";
  await assert.rejects(
    publishRelease(plan, staged, remote),
    /identity conflicts/,
  );
  await assert.rejects(
    publishRelease({ ...plan, action: "dry-run" }, staged, remote),
    /Only a publish plan/,
  );
});

test("no remote writes happen until the entire local set validates", async (t) => {
  const { staged } = fixture(t);
  const { state, remote } = fakeRemote();
  rmSync(join(staged, "linux-x86_64.json"));
  await assert.rejects(
    publishRelease(plan, staged, remote),
    /Missing or duplicate/,
  );
  assert.deepEqual(state.writes, []);
});

test("GitHub lookup errors fail closed; annotated tags are peeled", async () => {
  const remote = githubRemote("ImNallen/L1Git", async () => {
    throw new Error("HTTP 403");
  });
  await assert.rejects(remote.findRelease(plan.release.tag), /HTTP 403/);
  await assert.rejects(remote.commitOf(plan.release.tag), /HTTP 403/);
  const annotated = githubRemote("ImNallen/L1Git", async (endpoint) =>
    endpoint.includes("matching-refs")
      ? [
          [
            {
              ref: `refs/tags/${plan.release.tag}`,
              object: { type: "tag", sha: "b".repeat(40) },
            },
          ],
        ]
      : { object: { type: "commit", sha } },
  );
  assert.equal(await annotated.commitOf(plan.release.tag), sha);
});

test("artifact restore distinguishes missing, expired and API failure", async () => {
  const env = { GITHUB_REPOSITORY: "ImNallen/L1Git", GITHUB_RUN_ID: "100" };
  assert.equal(
    await restoreArtifact("release-plan", "unused", env, async () => [
      { artifacts: [] },
    ]),
    false,
  );
  await assert.rejects(
    restoreArtifact("release-plan", "unused", env, async () => [
      { artifacts: [{ name: "release-plan", expired: true }] },
    ]),
    /expired/,
  );
  await assert.rejects(
    restoreArtifact("release-plan", "unused", env, async () => {
      throw new Error("HTTP 403");
    }),
    /HTTP 403/,
  );
});

test("successful build artifacts restore their original bytes and metadata", async (t) => {
  const { dir, staged } = fixture(t);
  const zip = join(dir, "original.zip");
  execFileSync("zip", ["-qr", zip, "."], { cwd: staged });
  const output = join(dir, "restored");
  const env = {
    GITHUB_REPOSITORY: "ImNallen/L1Git",
    GITHUB_RUN_ID: "100",
    GITHUB_RUN_ATTEMPT: "2",
  };
  const api = async (endpoint) =>
    endpoint.endsWith("/zip")
      ? readFileSync(zip)
      : [
          {
            artifacts: [
              { name: "bundles-macos-universal", id: 9, expired: false },
            ],
          },
        ];
  assert.equal(
    await restoreArtifact("bundles-macos-universal", output, env, api),
    true,
  );
  assert.deepEqual(
    verifyAssets(plan, output).manifest,
    verifyAssets(plan, staged).manifest,
  );
});

test("missing successful build artifacts block rebuild while failed builds may retry", async () => {
  const env = {
    GITHUB_REPOSITORY: "ImNallen/L1Git",
    GITHUB_RUN_ID: "100",
    GITHUB_RUN_ATTEMPT: "2",
  };
  const api = (conclusion) => async (endpoint) =>
    endpoint.includes("/jobs?")
      ? [{ jobs: [{ name: "Build macos-universal", conclusion }] }]
      : [{ artifacts: [] }];
  await assert.rejects(
    restoreArtifact("bundles-macos-universal", "unused", env, api("success")),
    /Successful build artifact.*missing/,
  );
  assert.equal(
    await restoreArtifact(
      "bundles-macos-universal",
      "unused",
      env,
      api("failure"),
    ),
    false,
  );
});

test("staging ignores symlinks inside exploded app bundles", (t) => {
  const { dir } = fixture(t);
  const input = join(dir, "linux-x86_64");
  const appdir = join(input, "L1 Git.AppDir");
  mkdirSync(appdir);
  symlinkSync("missing", join(appdir, ".DirIcon"));
  assert.equal(
    stageAssets(plan, "linux-x86_64", input, join(dir, "fresh")).assets.length,
    2,
  );
});
