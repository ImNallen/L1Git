import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync, sign } from "node:crypto";
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
  githubApi,
  githubRemote,
  publishRelease as publishActual,
  restoreArtifact,
  reconcileNightlyFeed,
  stageAssets as stageActual,
  verifyAssets as verifyActual,
} from "./release-assets.mjs";

const pair = generateKeyPairSync("ed25519");
const keyId = Buffer.alloc(8, 7);
const publicPacket = Buffer.concat([
  Buffer.from("Ed"),
  keyId,
  pair.publicKey.export({ format: "der", type: "spki" }).subarray(-32),
]);
const publicKey = Buffer.from(
  `untrusted comment: test key\n${publicPacket.toString("base64")}\n`,
).toString("base64");
function signature(bytes, version) {
  const signed = sign(null, bytes, pair.privateKey);
  const trusted = `timestamp:1792754582\tfile:bundle\tversion:${version}`;
  const packet = Buffer.concat([Buffer.from("Ed"), keyId, signed]);
  const global = sign(
    null,
    Buffer.concat([signed, Buffer.from(trusted)]),
    pair.privateKey,
  );
  return Buffer.from(
    `untrusted comment: test signature\n${packet.toString("base64")}\ntrusted comment: ${trusted}\n${global.toString("base64")}\n`,
  ).toString("base64");
}
const stageAssets = stageActual;
const verifyAssets = (p, dir) => verifyActual(p, dir, publicKey);
const publishRelease = (p, dir, remote) =>
  publishActual(p, dir, remote, { publicKey });

const sha = "a".repeat(40);

test("binary response decoding does not force a release-asset Accept header", () => {
  const directory = mkdtempSync(join(tmpdir(), "l1git-gh-headers-"));
  const previousPath = process.env.PATH;
  try {
    writeFileSync(
      join(directory, "gh"),
      "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n",
      { mode: 0o755 },
    );
    process.env.PATH = `${directory}:${previousPath}`;
    const artifactArgs = JSON.parse(
      githubApi("repos/ImNallen/L1Git/actions/artifacts/1/zip", {
        binary: true,
      }).toString(),
    );
    assert.deepEqual(artifactArgs, [
      "api",
      "repos/ImNallen/L1Git/actions/artifacts/1/zip",
    ]);
    const releaseArgs = JSON.parse(
      githubApi("repos/ImNallen/L1Git/releases/assets/1", {
        binary: true,
        accept: "application/octet-stream",
      }).toString(),
    );
    assert.deepEqual(releaseArgs.slice(-2), [
      "-H",
      "Accept: application/octet-stream",
    ]);
  } finally {
    process.env.PATH = previousPath;
    rmSync(directory, { recursive: true, force: true });
  }
});

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
    createdAt: "2026-10-23T08:30:00.000Z",
    previousTag: null,
    promotedFrom: null,
  },
};

function fixture(t, releasePlan = plan) {
  const dir = mkdtempSync(join(tmpdir(), "l1git-assets-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const staged = join(dir, "staged");
  for (const target of TARGETS) {
    const input = join(dir, target.id);
    mkdirSync(input);
    for (const extension of target.extensions) {
      const payload = Buffer.from(
        `package ${target.id} ${extension.replace(/\.sig$/, "")}`,
      );
      writeFileSync(
        join(input, `bundle.${extension}`),
        extension.endsWith(".sig")
          ? signature(payload, releasePlan.release.version)
          : payload,
      );
    }
    stageAssets(releasePlan, target.id, input, staged);
  }
  return { dir, staged };
}

function fakeRemote() {
  const state = {
    release: null,
    feed: null,
    nextId: 1,
    tag: null,
    writes: [],
    bytes: new Map(),
    failAfterUploads: Infinity,
    failAfterPublish: false,
  };
  const remote = {
    commitOf: async () => state.tag,
    findRelease: async (tag) =>
      tag === "nightly" ? state.feed : state.release,
    notes: async () => "Release notes",
    stableTags: async () => [],
    latestFeed: async () => null,
    create: async (data) => {
      if (data.tag_name === "nightly") {
        state.writes.push("feed create");
        return (state.feed = { ...data, id: 2, assets: [] });
      }
      state.writes.push("create");
      return (state.release = { ...data, id: 1, assets: [] });
    },
    upload: async (_release, upload) => {
      if (state.bytes.size === state.failAfterUploads)
        throw new Error("Upload interrupted");
      state.writes.push(
        `${_release.tag_name === "nightly" ? "feed upload" : "upload"} ${upload.name}`,
      );
      const asset = {
        id: state.nextId++,
        state: "uploaded",
        name: upload.name,
        size: upload.size,
      };
      state.bytes.set(asset.id, upload.bytes);
      _release.assets.push(asset);
      return asset;
    },
    deleteAsset: async (id) => {
      state.writes.push(
        state.feed?.assets.some((asset) => asset.id === id)
          ? "feed delete"
          : "delete",
      );
      state.bytes.delete(id);
      for (const release of [state.release, state.feed])
        if (release)
          release.assets = release.assets.filter((asset) => asset.id !== id);
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
  assert.equal(set.assets.length, 6);
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
  writeFileSync(join(empty, "one.app.tar.gz"), "a");
  writeFileSync(join(empty, "one.app.tar.gz.sig"), "a");
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
  assert.equal(state.release.assets.length, 8);
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
  assert.deepEqual(
    state.writes.filter((write) => !write.startsWith("feed ")),
    writes,
  );
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
  await assert.rejects(remote.latestFeed(), /HTTP 403/);
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

test("feed recovery selects the highest published owned version and validates its download", async () => {
  const entry = (id, version, published) => ({
    id,
    tag_name: `v${version}`,
    published_at: published,
    draft: false,
    body: `<!-- l1git-source:${sha} -->`,
  });
  const releases = [
    entry(1, "0.2.0", "2026-10-29T12:00:00Z"),
    entry(2, "0.3.0", "2026-10-29T11:00:00Z"),
    {
      ...entry(3, "99.0.0", "2026-10-29T13:00:00Z"),
      body: "Unrelated release",
    },
  ];
  const bytes = Buffer.from(JSON.stringify({ version: "0.3.0" }));
  const asset = {
    id: 10,
    name: "latest.json",
    state: "uploaded",
    size: bytes.length,
  };
  const remote = githubRemote("ImNallen/L1Git", async (endpoint) => {
    if (endpoint.includes("/releases?")) return [releases];
    if (endpoint.includes("/releases/2/assets?")) return [[asset]];
    if (endpoint.endsWith("/releases/assets/10")) return bytes;
    throw new Error(`Unexpected API request ${endpoint}`);
  });
  assert.deepEqual(await remote.latestFeed(), bytes);
  asset.size++;
  await assert.rejects(remote.latestFeed(), /metadata conflicts/);
  asset.size = bytes.length;
  asset.state = "starter";
  await assert.rejects(remote.latestFeed(), /no complete updater feed/);
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
    3,
  );
});

test("an old stable draft cannot publish after a newer stable, while matching published retries still succeed", async (t) => {
  const stable = {
    ...plan,
    release: {
      ...plan.release,
      channel: "stable",
      version: "0.2.0",
      tag: "v0.2.0",
    },
  };
  const { dir } = fixture(t, stable);
  const staged = join(dir, "stable");
  for (const target of TARGETS)
    stageAssets(stable, target.id, join(dir, target.id), staged);
  const { state, remote } = fakeRemote();
  state.failAfterUploads = 1;
  await assert.rejects(
    publishRelease(stable, staged, remote),
    /Upload interrupted/,
  );
  remote.stableTags = async () => ["v0.3.0"];
  const writes = [...state.writes];
  await assert.rejects(
    publishRelease(stable, staged, remote),
    /would not advance/,
  );
  assert.deepEqual(state.writes, writes);
  remote.stableTags = async () => [];
  state.failAfterUploads = Infinity;
  await publishRelease(stable, staged, remote);
  remote.stableTags = async () => ["v0.3.0"];
  const publishedWrites = [...state.writes];
  await publishRelease(stable, staged, remote);
  assert.deepEqual(state.writes, publishedWrites);
});

test("stable updates the nightly feed, newer feeds never regress and retries are idempotent", async () => {
  const { state, remote } = fakeRemote();
  const bytes = (version) =>
    Buffer.from(JSON.stringify({ version, platforms: {} }));
  await reconcileNightlyFeed(plan, bytes(plan.release.version), remote);
  const stable = {
    ...plan,
    release: { ...plan.release, version: "0.1.1", channel: "stable" },
  };
  await reconcileNightlyFeed(stable, bytes("0.1.1"), remote);
  assert.equal(
    JSON.parse((await remote.download(state.feed.assets[0])).toString())
      .version,
    "0.1.1",
  );
  assert.equal(
    state.writes.filter((write) => write === "feed delete").length,
    1,
  );
  const writes = [...state.writes];
  await reconcileNightlyFeed(stable, bytes("0.1.1"), remote);
  await reconcileNightlyFeed(plan, bytes(plan.release.version), remote);
  assert.deepEqual(state.writes, writes);
  await assert.rejects(
    reconcileNightlyFeed(
      stable,
      Buffer.from(JSON.stringify({ version: "0.1.1", conflicting: true })),
      remote,
    ),
    /Same-version.*conflicts/,
  );
});

test("a failed mutable feed replacement resumes after the old asset was removed", async () => {
  const { state, remote } = fakeRemote();
  const first = Buffer.from(JSON.stringify({ version: plan.release.version }));
  await reconcileNightlyFeed(plan, first, remote);
  const stable = {
    ...plan,
    release: { ...plan.release, version: "0.1.1", channel: "stable" },
  };
  const bytes = Buffer.from(JSON.stringify({ version: "0.1.1" }));
  const upload = remote.upload;
  remote.upload = async () => {
    throw new Error("feed upload interrupted");
  };
  await assert.rejects(
    reconcileNightlyFeed(stable, bytes, remote),
    /interrupted/,
  );
  assert.equal(state.feed.assets.length, 0);
  remote.upload = upload;
  await reconcileNightlyFeed(stable, bytes, remote);
  assert.deepEqual(await remote.download(state.feed.assets[0]), bytes);
});

test("publication rejects an ephemeral PR key before remote writes", async (t) => {
  const { staged } = fixture(t);
  const { state, remote } = fakeRemote();
  await assert.rejects(
    publishActual(plan, staged, remote),
    /signed by key.*trusts key/,
  );
  assert.deepEqual(state.writes, []);
});

test("an older retry repairs an interrupted feed with the newest published version", async () => {
  const { state, remote } = fakeRemote();
  const bytes = (version) => Buffer.from(JSON.stringify({ version }));
  const release = (version) => ({
    ...plan,
    release: { ...plan.release, version },
  });
  await reconcileNightlyFeed(release("0.2.0"), bytes("0.2.0"), remote);
  remote.latestFeed = async () => bytes("0.3.0");
  const upload = remote.upload;
  remote.upload = async () => {
    throw new Error("Upload interrupted");
  };
  await assert.rejects(
    reconcileNightlyFeed(release("0.3.0"), bytes("0.3.0"), remote),
    /interrupted/,
  );
  assert.equal(state.feed.assets.length, 0);
  remote.upload = upload;
  await reconcileNightlyFeed(release("0.1.0"), bytes("0.1.0"), remote);
  assert.deepEqual(await remote.download(state.feed.assets[0]), bytes("0.3.0"));
});

test("a failed upload's empty starter asset is recovered in an owned draft", async (t) => {
  const { staged } = fixture(t);
  const { state, remote } = fakeRemote();
  const upload = remote.upload;
  remote.upload = async (release, entry) => {
    const asset = {
      id: state.nextId++,
      state: "starter",
      name: entry.name,
      size: 0,
    };
    release.assets.push(asset);
    state.bytes.set(asset.id, Buffer.alloc(0));
    throw new Error("HTTP 502");
  };
  await assert.rejects(publishRelease(plan, staged, remote), /HTTP 502/);
  remote.upload = upload;
  await publishRelease(plan, staged, remote);
  assert.equal(state.release.draft, false);
  assert.ok(state.writes.includes("delete"));
  assert.ok(state.release.assets.every((asset) => asset.state === "uploaded"));
});

test("an empty starter asset on the owned rolling feed is recovered", async () => {
  const { state, remote } = fakeRemote();
  const bytes = Buffer.from(JSON.stringify({ version: plan.release.version }));
  await reconcileNightlyFeed(plan, bytes, remote);
  state.feed.assets[0].state = "starter";
  state.feed.assets[0].size = 0;
  state.bytes.set(state.feed.assets[0].id, Buffer.alloc(0));
  await reconcileNightlyFeed(plan, bytes, remote);
  assert.deepEqual(await remote.download(state.feed.assets[0]), bytes);
});
