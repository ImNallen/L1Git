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
function commit(message, files) {
  for (const [file, contents] of Object.entries(files)) {
    const path = join(repository, file);
    if (contents === null) {
      rmSync(path);
    } else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents);
    }
  }
  git(repository, "add", "--all", "--", ...Object.keys(files));
  git(repository, "commit", "-m", message);
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
const fixture = { root, repository, remote, unborn, detached };
writeFileSync(
  join(root, "fixture.json"),
  `${JSON.stringify(fixture, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(fixture, null, 2)}\n`);
