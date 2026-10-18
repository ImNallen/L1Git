import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = process.argv[2]
  ? resolve(process.argv[2])
  : mkdtempSync(join(tmpdir(), "l1git-fixture-"));
if (process.argv[2] && existsSync(root))
  throw new Error(`Destination already exists: ${root}`);
mkdirSync(root, { recursive: true });
const repository = join(root, "l1-demo");
const remote = join(root, "remote.git");
const unborn = join(root, "unborn");
const detached = join(root, "detached-worktree");
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
);
let clock = 1_780_000_000;
function git(path, ...args) {
  const result = spawnSync("git", ["-C", path, ...args], {
    encoding: "utf8",
    env: {
      ...env,
      GIT_AUTHOR_NAME: "N Allen",
      GIT_AUTHOR_EMAIL: "nallen@example.test",
      GIT_COMMITTER_NAME: "N Allen",
      GIT_COMMITTER_EMAIL: "nallen@example.test",
      GIT_AUTHOR_DATE: `${clock} +0000`,
      GIT_COMMITTER_DATE: `${clock++} +0000`,
    },
  });
  if (result.status !== 0) throw new Error(result.stderr || "Git failed");
  return result.stdout.trim();
}
function commitIn(worktree, message, files) {
  for (const [file, contents] of Object.entries(files)) {
    const path = join(worktree, file);
    if (contents === null) {
      rmSync(path);
    } else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents);
    }
  }
  git(worktree, "add", "--all", "--", ...Object.keys(files));
  git(worktree, "commit", "-m", message);
}
function commit(message, files) {
  commitIn(repository, message, files);
}
mkdirSync(repository);
mkdirSync(remote);
mkdirSync(unborn);
git(remote, "init", "--bare", "--initial-branch=main");
git(repository, "init", "--initial-branch=main");
git(repository, "config", "core.hooksPath", "/dev/null");
commit("docs: start the local Git fixture", { "README.md": "# L1 demo\n" });
git(repository, "checkout", "-b", "feat/history");
commit("feat(history): add bounded repository history", {
  "history.ts": [
    "export const historyLimit = 200;",
    'export const historyOrder = "topological";',
    "export const historyIncludesRemotes = true;",
    "",
  ].join("\n"),
});
commit("feat(graph): connect commits to their actual parents", {
  "graph.ts": "export const graphUsesParentIds = true;\n",
});
git(repository, "checkout", "main");
commit("feat(theme): add the L1 dark canvas", {
  "theme.css": ":root { color-scheme: dark; }\n",
});
git(
  repository,
  "merge",
  "--no-ff",
  "feat/history",
  "-m",
  "Merge branch feat/history",
);
git(repository, "remote", "add", "origin", remote);
git(repository, "push", "origin", "main", "feat/history");
git(repository, "checkout", "-b", "feat/remote-inspector");
commit("feat(inspector): show commit message and changed paths", {
  "inspector.ts": 'export const diffBase = "first parent";\n',
  "src/inspector/files/tree.ts":
    "export const flattenEmptyDirectories = true;\n",
  "src/inspector/panel.ts": "export const inspectorWidth = 320;\n",
  "assets/icon.png": Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
  ]),
  "history.ts": [
    "export const historyLimit = 200;",
    'export const historyOrder = "first parent";',
    "export const historyIncludesRemotes = true;",
    "",
  ].join("\n"),
  "graph.ts": null,
});
git(repository, "push", "origin", "feat/remote-inspector");
git(repository, "checkout", "main");
git(repository, "branch", "-D", "feat/remote-inspector");
git(repository, "fetch", "origin");
git(repository, "remote", "set-head", "origin", "main");
git(repository, "branch", "--set-upstream-to=origin/main", "main");
git(
  repository,
  "remote",
  "add",
  "github",
  "git@github.com:l1-family/l1-git.git",
);
git(repository, "worktree", "add", "--detach", detached, "feat/history");
git(unborn, "init", "--initial-branch=main");

const sync = {
  repository: join(root, "sync-demo"),
  remote: join(root, "sync-remote.git"),
  colleague: join(root, "sync-colleague"),
  dirty: join(root, "sync-develop"),
};
mkdirSync(sync.repository);
mkdirSync(sync.remote);
git(sync.remote, "init", "--bare", "--initial-branch=main");
git(sync.repository, "init", "--initial-branch=main");
git(sync.repository, "config", "core.hooksPath", "/dev/null");
commitIn(sync.repository, "docs: start the sync fixture", {
  "README.md": "# Sync demo\n",
});
git(sync.repository, "branch", "develop");
git(sync.repository, "branch", "feat/diverged");
git(sync.repository, "remote", "add", "origin", sync.remote);
git(
  sync.repository,
  "push",
  "-u",
  "origin",
  "main",
  "develop",
  "feat/diverged",
);
git(root, "clone", sync.remote, sync.colleague);
git(sync.colleague, "config", "core.hooksPath", "/dev/null");
commitIn(sync.colleague, "feat: colleague work on main", {
  "main.txt": "from a colleague\n",
});
git(sync.colleague, "push", "origin", "main");
git(sync.colleague, "switch", "develop");
commitIn(sync.colleague, "feat: colleague work on develop", {
  "develop.txt": "from a colleague\n",
});
git(sync.colleague, "push", "origin", "develop");
git(sync.colleague, "switch", "feat/diverged");
commitIn(sync.colleague, "feat: colleague work on the diverged branch", {
  "theirs.txt": "from a colleague\n",
});
git(sync.colleague, "push", "origin", "feat/diverged");
git(sync.repository, "switch", "feat/diverged");
commitIn(sync.repository, "feat: local work on the diverged branch", {
  "ours.txt": "local\n",
});
git(sync.repository, "switch", "main");
git(sync.repository, "worktree", "add", sync.dirty, "develop");
writeFileSync(join(sync.dirty, "README.md"), "# Sync demo\n\nUncommitted.\n");
git(
  sync.repository,
  "remote",
  "add",
  "github",
  "git@github.com:l1-family/l1-git.git",
);
git(sync.repository, "config", "remote.github.skipFetchAll", "true");
const fixture = { root, repository, remote, unborn, detached, sync };
writeFileSync(
  join(root, "fixture.json"),
  `${JSON.stringify(fixture, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(fixture, null, 2)}\n`);
