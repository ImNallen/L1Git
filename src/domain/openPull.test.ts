import { expect, it } from "vitest";
import {
  baseChoices,
  between,
  bodyOf,
  headOf,
  pushed,
  remoteOf,
  titleOf,
} from "./openPull";
import { branchRefSchema } from "./overview";
import type { BranchStatus } from "./overview";
import { oidSchema, refSchema } from "./repository";
import type { Branch, Commit, Oid } from "./repository";

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
