import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const destination = process.argv[2];
const root = destination
  ? resolve(destination)
  : mkdtempSync(join(tmpdir(), "l1git-large-fixture-"));
if (destination) {
  try {
    mkdirSync(root);
  } catch (error) {
    throw new Error(
      `Destination must not exist and its parent must exist: ${root}`,
      { cause: error },
    );
  }
}
process.on("exit", (code) => {
  if (code !== 0) rmSync(root, { recursive: true, force: true });
});
const repository = join(root, "l1-large");
const worktree = join(root, "l1-large-worktree");
const env = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  ),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};
function git(path, args, input) {
  const result = spawnSync("git", ["-C", path, ...args], {
    encoding: "utf8",
    env,
    input,
  });
  if (!result.error && result.status === 0) return;
  const reason = result.error
    ? `failed: ${result.error.message}`
    : result.signal
      ? `was killed by ${result.signal}`
      : `exited with ${result.status}`;
  throw new Error(`git ${args[0]} ${reason}\n${result.stderr ?? ""}`, {
    cause: result.error,
  });
}

const totalCommits = 60_000;
const localBranchCount = 200;
const remoteBranchCount = 400;
const mergeEvery = 40;
const tagCount = 50;
const hotEvery = 100;
const hotLines = 400;
const oldTipPosition = 1_000;
const areas = ["graph", "sidebar", "inspector", "diff", "fetch"];
const kinds = ["feat", "fix", "chore", "perf"];
const authors = [
  "Ada Lovelace <ada@example.test>",
  "Grace Hopper <grace@example.test>",
  "Linus Torvalds <linus@example.test>",
  "Margaret Hamilton <margaret@example.test>",
  "Ken Thompson <ken@example.test>",
  "Barbara Liskov <barbara@example.test>",
  "Dennis Ritchie <dennis@example.test>",
  "Frances Allen <frances@example.test>",
];
const startTime = 1_700_000_000;
const minutes = 60;

const oldTipBranch = "archive/old-tip";
const fixedBranches = ["main", oldTipBranch];
const topicBranches = Array.from(
  { length: localBranchCount - fixedBranches.length },
  (_, i) => {
    const kind = kinds[i % kinds.length];
    const area = areas[Math.floor(i / kinds.length) % areas.length];
    return `${kind}/${area}/topic-${String(i + 1).padStart(3, "0")}`;
  },
);
const localBranches = [...topicBranches, oldTipBranch];
const upstreamBranches = Array.from(
  { length: remoteBranchCount - localBranchCount },
  (_, i) =>
    `contrib/user-${String(Math.floor(i / 10) + 1).padStart(2, "0")}/change-${String((i % 10) + 1).padStart(2, "0")}`,
);
const originState = (i) => ["synced", "behind", "ahead"][i % 3];
const extraOriginCommits = localBranches.filter(
  (_, i) => originState(i) === "behind",
).length;
const mainlineTarget =
  totalCommits -
  localBranches.length -
  extraOriginCommits -
  upstreamBranches.length;

const chunks = [];
let mark = 0;
function data(text) {
  chunks.push(`data ${Buffer.byteLength(text)}\n${text}\n`);
}
function commit({ ref, time, subject, from, merge, files }) {
  mark += 1;
  const author = authors[mark % authors.length];
  chunks.push(
    `commit ${ref}\nmark :${mark}\nauthor ${author} ${time} +0000\ncommitter ${author} ${time} +0000\n`,
  );
  data(`${subject}\n`);
  if (from) chunks.push(`from :${from}\n`);
  if (merge) chunks.push(`merge :${merge}\n`);
  for (const [path, contents] of files) {
    chunks.push(`M 100644 inline ${path}\n`);
    data(contents);
  }
  return mark;
}
function pointRef(ref, from) {
  chunks.push(`reset ${ref}\nfrom :${from}\n\n`);
}

const modules = areas.flatMap((area) =>
  Array.from(
    { length: 80 },
    (_, i) => `src/${area}/module-${String(i + 1).padStart(2, "0")}.ts`,
  ),
);
const revisions = new Map();
function editModule(position) {
  const path = modules[(position * 7919) % modules.length];
  const history = [...(revisions.get(path) ?? []), position].slice(-8);
  revisions.set(path, history);
  const lines = history.map((revision) => `  ${revision},`);
  return [
    path,
    `export const module = "${path}";\nexport const revisions = [\n${lines.join("\n")}\n];\n`,
  ];
}
const hotPath = "src/hot/history.ts";
const hot = Array.from({ length: hotLines }, (_, line) => `  [${line}, 0],`);
function editHot(position) {
  const line = (position / hotEvery) % hotLines;
  hot[line] = `  [${line}, ${position}],`;
  return [hotPath, `export const history = [\n${hot.join("\n")}\n];\n`];
}

const mainMarks = [];
const mainTimes = [];
let topics = 0;
let parent;
while (mainMarks.length + topics < mainlineTarget) {
  const position = mainMarks.length;
  const time = startTime + position * 10 * minutes;
  const remaining = mainlineTarget - (position + topics);
  const hotEdit = position % hotEvery === 0 ? [editHot(position)] : [];
  if ((position + 1) % mergeEvery === 0 && remaining >= 2) {
    topics += 1;
    const note = [
      `notes/${String(topics % 40).padStart(2, "0")}/topic-${topics}.md`,
      `# Topic ${topics}\n\nMerged at ${position}.\n`,
    ];
    const side = commit({
      ref: "refs/heads/main",
      time: time - 5 * minutes,
      subject: `docs: write topic ${topics}`,
      from: parent,
      files: [note, ...hotEdit],
    });
    parent = commit({
      ref: "refs/heads/main",
      time,
      subject: `Merge topic ${topics} into main`,
      from: parent,
      merge: side,
      files: [note, ...hotEdit],
    });
  } else {
    const files = [editModule(position)];
    if (position === 0) files.push(["README.md", "# L1 large fixture\n"]);
    files.push(...hotEdit);
    parent = commit({
      ref: "refs/heads/main",
      time,
      subject: `${kinds[position % kinds.length]}: revise ${files[0][0]} (${position + 1})`,
      from: parent,
      files,
    });
  }
  mainMarks.push(parent);
  mainTimes.push(time);
}
pointRef("refs/remotes/origin/main", parent);

const firstBase = Math.floor(mainMarks.length / 2);
const baseStep = Math.floor(
  (mainMarks.length - firstBase) /
    (2 * Math.max(topicBranches.length, upstreamBranches.length)),
);
function branchCommit(ref, name, position) {
  return commit({
    ref,
    time: mainTimes[position] + minutes,
    subject: `wip(${name.split("/")[1]}): start ${name}`,
    from: mainMarks[position],
    files: [[`changes/${name}.md`, `# ${name}\n\nBranched at ${position}.\n`]],
  });
}
localBranches.forEach((name, i) => {
  const position =
    name === oldTipBranch ? oldTipPosition : firstBase + 2 * i * baseStep;
  const tip = branchCommit(`refs/heads/${name}`, name, position);
  const originRef = `refs/remotes/origin/${name}`;
  const state = originState(i);
  if (state === "synced") pointRef(originRef, tip);
  if (state === "ahead") pointRef(originRef, mainMarks[position]);
  if (state === "behind")
    commit({
      ref: originRef,
      time: mainTimes[position] + 2 * minutes,
      subject: `wip(${name.split("/")[1]}): continue ${name} on origin`,
      from: tip,
      files: [[`changes/${name}.md`, `# ${name}\n\nContinued on origin.\n`]],
    });
});
upstreamBranches.forEach((name, i) =>
  branchCommit(
    `refs/remotes/upstream/${name}`,
    name,
    firstBase + (2 * i + 1) * baseStep,
  ),
);

for (let i = 0; i < tagCount; i += 1) {
  const position = Math.floor(((i + 1) * mainMarks.length) / tagCount) - 1;
  chunks.push(
    `tag v1.${i}.0\nfrom :${mainMarks[position]}\ntagger ${authors[i % authors.length]} ${mainTimes[position]} +0000\n`,
  );
  data(`Release v1.${i}.0\n`);
}
chunks.push("done\n");

mkdirSync(repository);
git(repository, [
  "init",
  "--quiet",
  "--object-format=sha1",
  "--ref-format=files",
  "--initial-branch=main",
]);
git(repository, ["fast-import", "--quiet", "--done"], chunks.join(""));
appendFileSync(
  join(repository, ".git", "config"),
  [
    "[core]",
    "\thooksPath = /dev/null",
    "[user]",
    "\tname = N Allen",
    "\temail = nallen@example.test",
    "[commit]",
    "\tgpgSign = false",
    '[remote "origin"]',
    "\turl = git@github.com:l1-family/l1-git.git",
    "\tfetch = +refs/heads/*:refs/remotes/origin/*",
    "\tskipFetchAll = true",
    '[remote "upstream"]',
    "\turl = https://github.com/l1-family/l1-git-upstream.git",
    "\tfetch = +refs/heads/*:refs/remotes/upstream/*",
    "\tskipFetchAll = true",
    ...["main", ...localBranches].flatMap((name) => [
      `[branch "${name}"]`,
      "\tremote = origin",
      `\tmerge = refs/heads/${name}`,
    ]),
    "",
  ].join("\n"),
);
git(repository, [
  "symbolic-ref",
  "refs/remotes/origin/HEAD",
  "refs/remotes/origin/main",
]);
git(repository, ["reset", "--quiet", "--hard", "main"]);
git(repository, ["worktree", "add", "--quiet", worktree, localBranches[0]]);
writeFileSync(
  join(worktree, "README.md"),
  "# L1 large fixture\n\nUncommitted.\n",
);
writeFileSync(join(worktree, "untracked.txt"), "Not added to Git.\n");

const fixture = { root, repository, worktree };
writeFileSync(
  join(root, "fixture.json"),
  `${JSON.stringify(fixture, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(fixture, null, 2)}\n`);
