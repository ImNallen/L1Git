import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "l1git-merge-fixture-"));
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
);
function git(path, ...args) {
  return execFileSync("git", ["-C", path, ...args], {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function make(name, conflict) {
  const path = join(root, name);
  const remote = join(root, `${name}.git`);
  mkdirSync(path);
  git(path, "init", "-b", "main");
  for (const [key, value] of Object.entries({
    "user.name": "Merge fixture",
    "user.email": "merge@example.test",
    "commit.gpgSign": "false",
    "core.hooksPath": "/dev/null",
    "maintenance.auto": "false",
    "gc.auto": "0",
  }))
    git(path, "config", key, value);
  writeFileSync(join(path, "conflict.txt"), "base\n");
  writeFileSync(join(path, "unrelated.txt"), "original\n");
  writeFileSync(join(path, ".gitignore"), "ignored.txt\n");
  git(path, "add", ".");
  git(path, "commit", "-m", "Base");
  git(path, "clone", "--bare", path, remote);
  git(path, "remote", "add", "origin", remote);
  git(path, "switch", "-c", "incoming");
  writeFileSync(
    join(path, conflict ? "conflict.txt" : "incoming.txt"),
    "incoming\n",
  );
  git(path, "add", ".");
  git(path, "commit", "-m", "Incoming change");
  git(path, "push", "origin", "HEAD:main");
  git(path, "switch", "main");
  writeFileSync(join(path, "conflict.txt"), "current\n");
  git(path, "commit", "-am", "Local change");
  git(path, "fetch", "origin");
  git(path, "branch", "--set-upstream-to=origin/main");
  const linked = join(root, `${name}-linked`);
  git(path, "worktree", "add", "-b", "linked", linked);
  git(linked, "branch", "--set-upstream-to=origin/main");
  writeFileSync(join(path, "notes.txt"), "Keep this untracked note.\n");
  writeFileSync(join(path, "ignored.txt"), "Keep this ignored note.\n");
  return {
    path,
    linked,
    remote,
    destination: git(path, "rev-parse", "HEAD"),
    source: git(path, "rev-parse", "@{upstream}"),
  };
}
console.log(
  JSON.stringify(
    { root, clean: make("clean", false), conflict: make("conflict", true) },
    null,
    2,
  ),
);
