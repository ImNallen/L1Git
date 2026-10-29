import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { ephemeralSigner } from "./updater-fixture-signing.mjs";
import { verifySignature } from "./updater-manifest.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function run(command, args, env = process.env) {
  return new Promise((yes, no) => {
    const child = spawn(command, args, {
      cwd: repository,
      env,
      stdio: "inherit",
    });
    child.on("error", no);
    child.on("exit", (code) =>
      code === 0 ? yes() : no(new Error(`${command} exited ${code}`)),
    );
  });
}
async function build() {
  if (!["darwin", "linux"].includes(process.platform))
    throw new Error("Use macOS or AppImage Linux for this verification app.");
  const port = Number(process.argv[3] ?? 9854);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("Expected a loopback port between 1024 and 65535.");
  const directory = await mkdtemp(join(tmpdir(), "l1git-updater-harness-"));
  const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repository,
    encoding: "utf8",
  }).trim();
  const identifier = `dev.l1.git.updater-fixture.run${randomBytes(6).toString("hex")}`;
  const signer = ephemeralSigner();
  const feed = `http://127.0.0.1:${port}/latest.json`;
  const env = {
    ...process.env,
    CARGO_TARGET_DIR: join(directory, "target"),
    CARGO_PROFILE_RELEASE_OPT_LEVEL: "0",
    CARGO_PROFILE_RELEASE_CODEGEN_UNITS: "256",
    L1GIT_FIXTURE_FEED: feed,
    L1GIT_FIXTURE_PUBLIC_KEY: signer.publicKey,
  };
  delete env.TAURI_SIGNING_PRIVATE_KEY;
  delete env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
  const product = "L1 Git Updater Fixture";
  const base = JSON.parse(
    await readFile(join(repository, "src-tauri/tauri.conf.json"), "utf8"),
  );
  const bundle = process.platform === "darwin" ? "app" : "appimage";
  const versions = ["0.1.0-nightly.20000101.1", "0.1.0-nightly.20000101.2"];
  const installed = join(directory, "installed");
  await mkdir(installed);
  await run("pnpm", ["build"]);
  let app;
  let artifact;
  for (const [index, version] of versions.entries()) {
    const config = join(directory, `version-${index + 1}.json`);
    await writeFile(
      config,
      JSON.stringify(
        {
          identifier,
          productName: product,
          version,
          build: { beforeBuildCommand: "" },
          app: {
            windows: base.app.windows.map((window) => ({
              ...window,
              title: `${product} ${version}`,
            })),
          },
          bundle: { targets: [bundle], createUpdaterArtifacts: false },
          plugins: {
            updater: {
              pubkey: signer.publicKey,
              requireSignedVersion: true,
              dangerInsecureTransportProtocol: true,
            },
          },
        },
        null,
        2,
      ),
    );
    await run(
      "pnpm",
      [
        "tauri",
        "build",
        "--ci",
        "--features",
        "updater-fixture",
        "--config",
        config,
        "--bundles",
        bundle,
      ],
      env,
    );
    if (process.platform === "darwin") {
      const source = join(
        env.CARGO_TARGET_DIR,
        "release/bundle/macos",
        `${product}.app`,
      );
      if (index === 0) {
        app = join(installed, `${product}.app`);
        await cp(source, app, { recursive: true });
      } else {
        artifact = join(directory, "successor.app.tar.gz");
        await run("tar", [
          "-czf",
          artifact,
          "-C",
          dirname(source),
          basename(source),
        ]);
      }
    } else {
      const bundles = join(env.CARGO_TARGET_DIR, "release/bundle/appimage");
      const name = (await readdir(bundles)).find(
        (name) => name.endsWith(".AppImage") && name.includes(version),
      );
      if (!name) throw new Error("AppImage not found");
      const source = join(bundles, name);
      if (index === 0) {
        app = join(installed, name);
        await copyFile(source, app);
      } else {
        artifact = join(directory, "successor.AppImage");
        await copyFile(source, artifact);
      }
    }
  }
  const bytes = await readFile(artifact);
  const signature = signer.sign(bytes, versions[1]);
  if (
    verifySignature(signer.publicKey, signature, bytes).version !== versions[1]
  )
    throw new Error("Fixture signature verification failed");
  const platform = `${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch}`;
  await writeFile(
    join(directory, "latest.json"),
    JSON.stringify(
      {
        version: versions[1],
        notes:
          "Disposable signed updater verification. Expected successor ends in .2.",
        platforms: {
          [platform]: {
            signature,
            url: `http://127.0.0.1:${port}/${basename(artifact)}`,
          },
        },
      },
      null,
      2,
    ),
  );
  const metadata = {
    sourceSha,
    directory,
    identifier,
    port,
    app,
    artifact,
    feed,
    installedVersion: versions[0],
    successorVersion: versions[1],
  };
  await writeFile(
    join(directory, "harness.json"),
    JSON.stringify(metadata, null, 2),
  );
  await writeFile(
    join(directory, "README.txt"),
    [
      `Checkout ${repository} at ${sourceSha}`,
      `Build command: node scripts/updater-harness.mjs build ${port}`,
      `Feed command: node ${join(repository, "scripts/updater-harness.mjs")} serve ${directory}`,
      `Launch only when the parent owns the desktop: ${process.platform === "darwin" ? `open -n '${app}'` : `'${app}'`}`,
      `Verify packaged download: L1GIT_PACKAGED_FIXTURE_DIR='${directory}' cargo test --locked -p l1-git packaged_fixture_feed_downloads_the_exact_signed_successor -- --ignored`,
      `Expected installed version after update: ${versions[1]}`,
      `Isolated app identifier: ${identifier}`,
      "Only open disposable repositories in this app. No HOME overrides or private signing key files were used.",
      "This artifact has not been driven in a GUI. Check, download, confirm, install, restart and inspect Updates to prove replacement.",
    ].join("\n") + "\n",
  );
  process.stdout.write(`${JSON.stringify(metadata, null, 2)}\n`);
}
async function serve(directory) {
  const metadata = JSON.parse(
    await readFile(join(directory, "harness.json"), "utf8"),
  );
  const allowed = new Set(["/latest.json", `/${basename(metadata.artifact)}`]);
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, metadata.feed).pathname;
    if (!allowed.has(path)) {
      response.writeHead(404).end();
      return;
    }
    try {
      const bytes = await readFile(join(directory, path.slice(1)));
      response.writeHead(200, {
        "Content-Type": path.endsWith(".json")
          ? "application/json"
          : "application/octet-stream",
        "Content-Length": bytes.length,
        "Cache-Control": "no-store",
      });
      response.end(bytes);
    } catch {
      response.writeHead(500).end();
    }
  });
  server.listen(metadata.port, "127.0.0.1", () =>
    process.stdout.write(
      `Disposable updater feed ${metadata.feed}\nApp ${metadata.app}\n`,
    ),
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => server.close());
}
if (process.argv[2] === "build") await build();
else if (process.argv[2] === "serve" && process.argv[3])
  await serve(resolve(process.argv[3]));
else throw new Error("Use build [port] or serve <harness-directory>.");
