import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";

export const PUBLIC_KEY = readFileSync(
  new URL("./updater-public-key.txt", import.meta.url),
  "utf8",
).trim();

export const TARGETS = [
  {
    id: "macos-universal",
    bundleDirectory: "target/universal-apple-darwin/release/bundle",
    os: "macos-latest",
    rustTargets: "aarch64-apple-darwin,x86_64-apple-darwin",
    args: "--target universal-apple-darwin --bundles app,dmg",
    bundles: [
      {
        extension: "app.tar.gz",
        platforms: ["darwin-aarch64", "darwin-x86_64"],
      },
      { extension: "dmg", platforms: [] },
    ],
  },
  {
    id: "linux-x86_64",
    bundleDirectory: "target/x86_64-unknown-linux-gnu/release/bundle",
    os: "ubuntu-24.04",
    rustTargets: "x86_64-unknown-linux-gnu",
    args: "--target x86_64-unknown-linux-gnu --bundles appimage,deb",
    bundles: [
      { extension: "AppImage", platforms: ["linux-x86_64"] },
      { extension: "deb", platforms: [] },
    ],
  },
].map((target) => ({
  ...target,
  extensions: target.bundles.flatMap((bundle) =>
    bundle.platforms.length
      ? [bundle.extension, `${bundle.extension}.sig`]
      : [bundle.extension],
  ),
}));

export const bundleName = (version, target, extension) =>
  `L1Git_${version}_${target.id}.${extension}`;

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const lines = (base64) =>
  Buffer.from(base64.trim(), "base64").toString("utf8").trim().split(/\r?\n/);
const keyId = (bytes) =>
  Buffer.from(bytes).reverse().toString("hex").toUpperCase();

export function verifySignature(publicKey, signature, data) {
  const pk = Buffer.from(lines(publicKey)[1], "base64");
  const [, sigLine, trustedLine, globalLine] = lines(signature);
  if (
    pk.length !== 42 ||
    !sigLine ||
    !trustedLine?.startsWith("trusted comment: ") ||
    !globalLine
  )
    throw new Error("Malformed updater signature or public key.");
  const sig = Buffer.from(sigLine, "base64");
  if (sig.length !== 74 || Buffer.from(globalLine, "base64").length !== 64)
    throw new Error("Malformed updater signature.");
  if (!pk.subarray(2, 10).equals(sig.subarray(2, 10))) {
    throw new Error(
      `signed by key ${keyId(sig.subarray(2, 10))}, but the updater trusts key ${keyId(pk.subarray(2, 10))}`,
    );
  }
  const key = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, pk.subarray(10)]),
    format: "der",
    type: "spki",
  });
  const algorithm = sig.subarray(0, 2).toString("latin1");
  if (!["ED", "Ed"].includes(algorithm))
    throw new Error("Unsupported updater signature algorithm.");
  const message =
    algorithm === "ED" ? createHash("blake2b512").update(data).digest() : data;
  if (!verify(null, message, key, sig.subarray(10)))
    throw new Error("signature does not match the file");
  const trusted = trustedLine.replace(/^trusted comment: /, "");
  if (
    !verify(
      null,
      Buffer.concat([sig.subarray(10), Buffer.from(trusted)]),
      key,
      Buffer.from(globalLine, "base64"),
    )
  ) {
    throw new Error("trusted comment signature does not match");
  }
  return Object.fromEntries(
    trusted
      .split("\t")
      .map((field) => [
        field.slice(0, field.indexOf(":")),
        field.slice(field.indexOf(":") + 1),
      ]),
  );
}

export function buildManifest({
  repository,
  plan,
  files,
  publicKey = PUBLIC_KEY,
}) {
  const { version, tag, createdAt, sha } = plan.release;
  const platforms = {};
  for (const target of TARGETS) {
    for (const bundle of target.bundles) {
      const name = bundleName(version, target, bundle.extension);
      const bytes = files[name];
      if (!bytes?.length) throw new Error(`${name} was not built.`);
      if (!bundle.platforms.length) continue;
      const signature = files[`${name}.sig`]?.toString("utf8").trim();
      if (!signature) throw new Error(`${name} has no signature.`);
      const trusted = verifySignature(publicKey, signature, bytes);
      if (trusted.version !== version)
        throw new Error(
          `${name}: signature binds ${trusted.version || "no app version"}, not ${version}.`,
        );
      for (const platform of bundle.platforms)
        platforms[platform] = {
          signature,
          url: `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(name)}`,
        };
    }
  }
  return {
    version,
    notes: `${tag} from ${sha}. ${plan.reason}`,
    pub_date: createdAt,
    platforms,
  };
}
