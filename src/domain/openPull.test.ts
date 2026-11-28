import { expect, it } from "vitest";
import {
  baseChoices,
  between,
  bodyOf,
  checkoutOf,
  firstStep,
  headOf,
  pushed,
  remoteOf,
  signedInProblem,
  titleOf,
  unopenable,
} from "./openPull";
import type { Checkout } from "./openPull";
import { branchRefSchema } from "./overview";
import type { BranchStatus } from "./overview";
import { oidSchema, refSchema } from "./repository";
import type { Branch, Commit, Oid, RepositoryRoot } from "./repository";

const oid = (digit: string) => oidSchema.parse(digit.repeat(40));
const commit = (at: string, parents: string[], subject = at): Commit => ({
  oid: oid(at),
  parents: parents.map(oid),
  subject,
  author: "Pin Author",
  email: "pin@example.com",
  timestamp: 0,
});
const remote = (name: string, at: Oid, on = "origin"): Branch => ({
  kind: "remote",
  reference: refSchema.parse(`refs/remotes/${on}/${name}`),
  name: `${on}/${name}`,
  oid: at,
  remote: on,
});

// 1 ← 2 ← 3 (main), 2 ← 4 ← 5 (feature), 3 + 5 ← 6 (merged)
const commits = [
  commit("6", ["3", "5"]),
  commit("5", ["4"], "Second"),
  commit("4", ["2"], "First"),
  commit("3", ["2"]),
  commit("2", ["1"]),
  commit("1", []),
];

it("lists what the head has and the base lacks, newest first", () => {
  expect(between(commits, oid("3"), oid("5"))).toEqual({
    commits: [commits[1], commits[2]],
    complete: true,
  });
  expect(between(commits, oid("6"), oid("5")).commits).toEqual([]);
  expect(
    between(commits, oid("5"), oid("6")).commits.map((c) => c.oid),
  ).toEqual([oid("6"), oid("3")]);
  expect(titleOf(between(commits, oid("3"), oid("5")).commits)).toBe("First");
});

it("says when the walk ran past the loaded history", () => {
  const cut = commits.slice(0, 3);
  expect(between(cut, oid("3"), oid("5")).complete).toBe(false);
});

it("tells a pushed branch from one the remote lacks, is behind on, or moved apart from", () => {
  const head = { name: "feature", oid: oid("5"), local: true };
  const at = (tip: string | null) => ({
    commits,
    branches: tip === null ? [] : [remote("feature", oid(tip))],
  });
  expect(pushed(at("5"), "origin", head)).toEqual({ kind: "pushed" });
  expect(pushed(at(null), "origin", head)).toEqual({ kind: "missing" });
  expect(pushed(at("4"), "origin", head)).toEqual({ kind: "ahead", ahead: 1 });
  expect(pushed(at("3"), "origin", head)).toEqual({ kind: "diverged" });
  expect(
    pushed(at("5"), "origin", { ...head, oid: oid("4") }),
    "only behind is not moved apart",
  ).toEqual({ kind: "behind", behind: 1 });
});

it("takes Git's counts for a branch that tracks the remote's copy, past the loaded history", () => {
  const head = { name: "feature", oid: oid("5"), local: true };
  // Only the newest commit loaded, as in a repository past the history
  // limit: the walk from either tip runs out.
  const cut = {
    commits: commits.slice(1, 2),
    branches: [remote("feature", oid("4"))],
  };
  const status = (
    state: BranchStatus["state"],
    at: Oid = oid("5"),
  ): BranchStatus => ({
    reference: branchRefSchema.parse("refs/heads/feature"),
    name: "feature",
    oid: at,
    role: "other",
    checkedOutAt: null,
    state,
  });
  const upstream = refSchema.parse("refs/remotes/origin/feature");
  expect(
    pushed(cut, "origin", head, [
      status({ kind: "ahead", upstream, ahead: 3 }),
    ]),
  ).toEqual({ kind: "ahead", ahead: 3 });
  expect(
    pushed(cut, "origin", head, [
      status({
        kind: "behind",
        upstream,
        target: oid("4"),
        behind: 2,
        blocker: null,
      }),
    ]),
  ).toEqual({ kind: "behind", behind: 2 });
  expect(
    pushed(cut, "origin", head, [
      status({ kind: "diverged", upstream, ahead: 1, behind: 2 }),
    ]),
  ).toEqual({ kind: "diverged" });
  expect(
    pushed(cut, "origin", head),
    "without counts, it can't tell, and says so",
  ).toEqual({ kind: "unknown" });
  expect(
    pushed(cut, "origin", head, [
      status({ kind: "ahead", upstream, ahead: 3 }, oid("6")),
    ]),
    "counts for another commit of the branch don't count",
  ).toEqual({ kind: "unknown" });
  expect(
    pushed(cut, "origin", head, [
      status({
        kind: "ahead",
        upstream: refSchema.parse("refs/remotes/origin/main"),
        ahead: 3,
      }),
    ]),
    "nor do counts against another upstream",
  ).toEqual({ kind: "unknown" });
});

it("finds the remote that is the repository on GitHub, upstream first", () => {
  const github = { owner: "Octo", repo: "pin" };
  const on = (name: string, owner: string) => ({
    name,
    url: "",
    github: { owner, repo: "pin" },
  });
  expect(remoteOf([on("fork", "octo"), on("origin", "octo")], github)).toBe(
    "origin",
  );
  expect(remoteOf([on("origin", "octo"), on("upstream", "octo")], github)).toBe(
    "upstream",
  );
  expect(remoteOf([on("origin", "hubot")], github)).toBeNull();
});

it("names a head by its branch on GitHub's remote only", () => {
  expect(headOf(remote("fix/a", oid("5")), "origin")).toEqual({
    name: "fix/a",
    oid: oid("5"),
    local: false,
  });
  expect(headOf(remote("fix/a", oid("5"), "fork"), "origin")).toBeNull();
  expect(headOf(remote("HEAD", oid("5")), "origin")).toBeNull();
  expect(
    baseChoices(
      {
        branches: [
          remote("main", oid("3")),
          remote("HEAD", oid("3")),
          remote("feature", oid("5")),
          remote("dev", oid("3"), "fork"),
        ],
      },
      "origin",
      "feature",
    ),
  ).toEqual(["main"]);
});

it("takes a commit message's body without its subject", () => {
  expect(bodyOf("Fix it\n\nStart at a.rs.\r\n\n")).toBe("Start at a.rs.");
  expect(bodyOf("Fix it\n")).toBe("");
});

const TRACKED = "refs/remotes/origin/topic";
const here = { kind: "here" } as const;

it("publishes or pushes first only the branch checked out here, and never past a diverged one", () => {
  const step = (
    state: Parameters<typeof firstStep>[0],
    checkout: Checkout,
    upstream: string | null = null,
  ) =>
    firstStep(state, { head: "topic", remote: "origin", upstream, checkout })
      .kind;
  const nowhere = { kind: "nowhere" } as const;
  expect(step({ kind: "pushed" }, nowhere)).toBe("none");
  expect(step({ kind: "missing" }, here)).toBe("publish");
  expect(step({ kind: "ahead", ahead: 2 }, here, TRACKED)).toBe("push");
  expect(step({ kind: "missing" }, nowhere)).toBe("blocked");
  expect(step({ kind: "ahead", ahead: 2 }, nowhere, TRACKED)).toBe("blocked");
  expect(step({ kind: "diverged" }, here, TRACKED)).toBe("blocked");
  expect(step({ kind: "behind", behind: 1 }, here, TRACKED)).toBe("blocked");
  expect(step({ kind: "unknown" }, here, TRACKED)).toBe("blocked");
  expect(
    firstStep(
      { kind: "ahead", ahead: 2 },
      { head: "topic", remote: "origin", upstream: TRACKED, checkout: here },
    ),
  ).toEqual({
    kind: "push",
    message:
      "origin doesn't have 2 commits of topic yet. L1 Git pushes first, with your Git credentials, then opens the pull request.",
  });
});

it("decides between publish and push from the upstream, as the core does", () => {
  const step = (
    state: Parameters<typeof firstStep>[0],
    upstream: string | null,
  ) =>
    firstStep(state, {
      head: "topic",
      remote: "origin",
      upstream,
      checkout: here,
    });
  // git switch -c topic origin/main: it tracks origin/main, and origin has
  // no topic. The core publishes no branch with an upstream.
  expect(step({ kind: "missing" }, "refs/remotes/origin/main")).toEqual({
    kind: "blocked",
    message:
      "topic isn't on origin yet. topic tracks origin/main, so L1 Git can't publish it as topic on origin. Push it there in Git first, then open the pull request.",
  });
  // git push origin topic without -u, then a commit: origin has topic, but
  // topic tracks nothing. The core pushes no branch without an upstream,
  // and publishes it.
  expect(step({ kind: "ahead", ahead: 1 }, null)).toEqual({
    kind: "publish",
    message:
      "origin doesn't have 1 commit of topic yet. L1 Git publishes it first, with your Git credentials, then opens the pull request.",
  });
  expect(step({ kind: "missing" }, TRACKED).kind, "its upstream is gone").toBe(
    "push",
  );
  expect(step({ kind: "ahead", ahead: 1 }, "refs/heads/main")).toMatchObject({
    kind: "blocked",
    message: expect.stringContaining("topic tracks main,"),
  });
  expect(step({ kind: "pushed" }, "refs/remotes/origin/main").kind).toBe(
    "none",
  );
});

it("says to switch to the worktree a branch is checked out in, not to check it out", () => {
  const worktree = (name: string, branch: string, current: boolean) => ({
    root: `/r/${name}` as RepositoryRoot,
    name,
    head: {
      kind: "attached" as const,
      reference: refSchema.parse(`refs/heads/${branch}`),
      oid: oid("5"),
    },
    current,
    main: current,
  });
  const snapshot = {
    head: worktree("pin", "main", true).head,
    worktrees: [
      worktree("pin", "main", true),
      worktree("pin-topic", "topic", false),
    ],
  };
  expect(checkoutOf(snapshot, "main")).toEqual({ kind: "here" });
  expect(checkoutOf(snapshot, "topic")).toEqual({
    kind: "elsewhere",
    worktree: "pin-topic",
  });
  expect(checkoutOf(snapshot, "other")).toEqual({ kind: "nowhere" });
  expect(
    firstStep(
      { kind: "missing" },
      {
        head: "topic",
        remote: "origin",
        upstream: null,
        checkout: checkoutOf(snapshot, "topic"),
      },
    ),
  ).toEqual({
    kind: "blocked",
    message:
      "topic isn't on origin yet. It's checked out in the worktree pin-topic. Switch to that worktree to publish it, then open the pull request.",
  });
});

it("tells what the host would refuse to open before anything is sent", () => {
  const open = { title: "Fix it", body: "", head: "topic", base: "main" };
  expect(unopenable(open)).toBeNull();
  expect(unopenable({ ...open, title: "x".repeat(256) })).toBeNull();
  expect(unopenable({ ...open, title: "x".repeat(257) })).toBe(
    "A pull request needs a title of at most 256 characters.",
  );
  expect(unopenable({ ...open, title: "  " })).toBe(
    "A pull request needs a title of at most 256 characters.",
  );
  expect(unopenable({ ...open, body: "é".repeat(65_536) })).toBeNull();
  expect(unopenable({ ...open, body: "x".repeat(65_537) })).toBe(
    "A description holds at most 65,536 characters.",
  );
  expect(unopenable({ ...open, base: "topic" })).toBe(
    "A pull request merges one branch into another.",
  );
  expect(signedInProblem("octo", "Octo")).toBeNull();
  expect(signedInProblem("octo", "hubot")).toBe(
    "L1 Git is signed in to GitHub as hubot, not octo.",
  );
  expect(signedInProblem("octo", null)).toBe(
    "L1 Git is not connected to GitHub. Sign in from Settings › Hosts.",
  );
});
