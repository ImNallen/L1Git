import assert from "node:assert/strict";
import test from "node:test";
import {
  TARGETS,
  PUBLIC_KEY,
  buildManifest,
  bundleName,
  verifySignature,
} from "./updater-manifest.mjs";

const payload = Buffer.from("L1 Data updater bundle fixture\n");
const tauriPublicKey =
  "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDU5NjYwMkQxRjc0RTg1OEQKUldTTmhVNzMwUUptV2FqTzYwM0FVRzRjOFdEdEdLd1NCbUMxclJKY1NJTm9LNEx3TGMwTG9nWnUK";
const tauriSignature =
  "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVTTmhVNzMwUUptV1VzVnJrd0F6WE1LdG5nU1FUcldFWFFGcGxJSDFOazY5dVdyVzVZUWRMU3dNWHJIbk9YUnVIWUVLZWxNUG5rc0lFeFdyMjA2U2JjaXY5ZTJUa0RKMGdNPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkyNzU0NTgyCWZpbGU6cGF5bG9hZC5iaW4JdmVyc2lvbjowLjEuNS1uaWdodGx5LjIwMjYxMDIzLjQyCkxIZDM3QWlLNUNza3BoanVSR24rVmk1WFVkTWNLdTlTMXk3QlJDaVZXSS9HaUJnWVZCY0JlUnFVZVJMdHN5bHpKYXVjc3ovdXNHNzEyYzc3NFFxa0FBPT0K";
const tauriUnboundSignature =
  "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVTTmhVNzMwUUptV2Q4c3ZMQ2k4ODFaY2RoK1hGZTVpWThta3JBNTY5L0doRzBCRnhHTGl0OXRNdTgyYzZ2Q0QyQkpIcUxKTlVrcGVVTklFZzVGWlYyeHlKY0hwTHNWU2dFPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkyNzU0MTMxCWZpbGU6cGF5bG9hZC5iaW4KU0NTemVZS2tCVC9sREJxc3RaRTFaVk4wM1A1WWxDOWlaRDF1Qy9hWUFKME5XUFV2N2ZFc09Vb1I2MGw3Y3JqYWpGSCtjc2tFazNZQWxvZmdGWVBaQ2c9PQo=";
const tauriOtherVersionSignature =
  "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVTTmhVNzMwUUptV1p2TUpwWHdWbkJVOHVyQmZOcEFsOWZiY3hWQVRQMm0xdERvSXBta3B5bU5zaysyTTJkMU82QjJhMEVPSU5jMVVPZUxJbS82S3NzSGpRRTZ2WDJZdlFJPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkyNzU0NTg4CWZpbGU6cGF5bG9hZC5iaW4JdmVyc2lvbjowLjEuNAp6MUJOaTBuSnQ4RlBLSk1iVGxNTnJSSFpJY21ORGNINXJNaEFwRHVNbmQ5S3ZxUllIOEtmdjhHeXBDcmt2WXFadE9VMG5RL0NmVmwwdnc0TWVnandEZz09Cg==";
const tauriOtherKeySignature =
  "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVRbGJxRUcrM1RweUJKNkRMUUUrVlN1YTg5QUZxTHVNRlVHdnZtYTdOak15MmFURmtaL3EzNHJxVEFqMEZXbDBTNU41TkRMa3FGS1JYK3RWc0RQMmQ3SFNPZERKM1ZpUndrPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkyNzU0NTgyCWZpbGU6cGF5bG9hZC5iaW4JdmVyc2lvbjowLjEuNS1uaWdodGx5LjIwMjYxMDIzLjQyCm8xdDNRRTVXOW1QM1BHOVRWWXN3WUNLRENYN2NFNkI5cWt5VHl3V3lzcHZRQXhmcUs0TFlJZzUrZnlpdkdkUS9yUUxxRncxTVFQUVZ1anE5UEh4NkJBPT0K";

const version = "0.1.5-nightly.20261023.42";
const plan = {
  reason: "Test release",
  release: {
    version,
    tag: `v${version}`,
    sha: "a".repeat(40),
    createdAt: "2026-10-23T08:30:00.000Z",
  },
};
const files = () =>
  Object.fromEntries(
    TARGETS.flatMap((target) =>
      target.bundles.flatMap((bundle) => {
        const name = bundleName(version, target, bundle.extension);
        return bundle.platforms.length
          ? [
              [name, payload],
              [`${name}.sig`, Buffer.from(tauriSignature)],
            ]
          : [[name, Buffer.from(bundle.extension)]];
      }),
    ),
  );
const build = (overrides = {}) =>
  buildManifest({
    repository: "ImNallen/L1Git",
    plan,
    publicKey: tauriPublicKey,
    files: files(),
    ...overrides,
  });

test("real Tauri signatures verify both payload and signed app version", () => {
  assert.equal(
    verifySignature(tauriPublicKey, tauriSignature, payload).version,
    version,
  );
  assert.throws(
    () =>
      verifySignature(tauriPublicKey, tauriSignature, Buffer.from("tampered")),
    /signature does not match/,
  );
  assert.throws(
    () => verifySignature(tauriPublicKey, tauriOtherKeySignature, payload),
    /signed by key.*trusts key/,
  );
  assert.throws(
    () => verifySignature(PUBLIC_KEY, tauriSignature, payload),
    /signed by key.*trusts key/,
  );
});

test("feed names four updater platforms with a shared universal macOS archive", () => {
  const feed = build();
  assert.deepEqual(Object.keys(feed.platforms).sort(), [
    "darwin-aarch64",
    "darwin-x86_64",
    "linux-x86_64",
    "windows-x86_64",
  ]);
  assert.deepEqual(
    feed.platforms["darwin-aarch64"],
    feed.platforms["darwin-x86_64"],
  );
  assert.match(
    feed.platforms["darwin-aarch64"].url,
    /ImNallen\/L1Git\/releases\/download\/v0.1.5-nightly.*macos-universal.app.tar.gz$/,
  );
  assert.match(feed.platforms["linux-x86_64"].url, /linux-x86_64.AppImage$/);
  assert.match(feed.platforms["windows-x86_64"].url, /windows-x86_64.exe$/);
  assert.equal(feed.version, version);
  assert.equal(feed.pub_date, plan.release.createdAt);
});

test("feed creation requires every installer and signature from the registry", () => {
  for (const name of Object.keys(files())) {
    const missing = files();
    delete missing[name];
    assert.throws(
      () => build({ files: missing }),
      /was not built|has no signature/,
    );
  }
});

test("unsigned version comments, other versions and untrusted comment edits fail", () => {
  const name = bundleName(version, TARGETS[0], "app.tar.gz") + ".sig";
  assert.throws(
    () =>
      build({
        files: { ...files(), [name]: Buffer.from(tauriUnboundSignature) },
      }),
    /signature binds no app version/,
  );
  assert.throws(
    () =>
      build({
        files: { ...files(), [name]: Buffer.from(tauriOtherVersionSignature) },
      }),
    /signature binds 0.1.4/,
  );
  const modified = Buffer.from(
    Buffer.from(tauriSignature, "base64")
      .toString("utf8")
      .replace(`version:${version}`, "version:9.9.9"),
  ).toString("base64");
  assert.throws(
    () => verifySignature(tauriPublicKey, modified, payload),
    /trusted comment signature/,
  );
  assert.throws(
    () => verifySignature(tauriPublicKey, "malformed", payload),
    /Malformed/,
  );
});
