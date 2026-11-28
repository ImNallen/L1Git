import type {
  Branch,
  Commit,
  GitHubRepository,
  Oid,
  RepositorySnapshot,
} from "./repository";
import { divergence } from "./overview";
import type { BranchStatus } from "./overview";

/** The remote that is `github`: `upstream`, then `origin`, then any other,
 * as the core picks the repository that pull requests open in. */
export function remoteOf(
  remotes: RepositorySnapshot["remotes"],
  github: GitHubRepository,
): string | null {
  const same = (other: GitHubRepository | null) =>
    other !== null &&
    other.owner.toLowerCase() === github.owner.toLowerCase() &&
    other.repo.toLowerCase() === github.repo.toLowerCase();
  const rank = (name: string) =>
    name === "upstream" ? 0 : name === "origin" ? 1 : 2;
  return (
    remotes
      .filter((remote) => same(remote.github))
      .sort((a, b) => rank(a.name) - rank(b.name))[0]?.name ?? null
  );
}

/** The branch a pull request opens from, by its name on GitHub. */
export type OpenHead = { name: string; oid: Oid; local: boolean };

/** Null for a branch of another remote, which GitHub doesn't know by this
 * repository. */
export function headOf(branch: Branch, remote: string): OpenHead | null {
  if (branch.kind === "local")
    return { name: branch.name, oid: branch.oid, local: true };
  const prefix = `${remote}/`;
  if (branch.remote !== remote || !branch.name.startsWith(prefix)) return null;
  const name = branch.name.slice(prefix.length);
  return name === "HEAD" ? null : { name, oid: branch.oid, local: false };
}

/** `remote`'s copy of `name`, as the last fetch left it. */
export function onRemote(
  snapshot: Pick<RepositorySnapshot, "branches">,
  remote: string,
  name: string,
): Oid | null {
  const reference = `refs/remotes/${remote}/${name}`;
  return (
    snapshot.branches.find(
      (branch) => branch.kind === "remote" && branch.reference === reference,
    )?.oid ?? null
  );
}

/** The branches `remote` has, by name, that a pull request from `head` could
 * merge into. */
export function baseChoices(
  snapshot: Pick<RepositorySnapshot, "branches">,
  remote: string,
  head: string,
): string[] {
  const prefix = `refs/remotes/${remote}/`;
  return snapshot.branches
    .filter(
      (branch) =>
        branch.kind === "remote" && branch.reference.startsWith(prefix),
    )
    .map((branch) => branch.reference.slice(prefix.length))
    .filter((name) => name !== "HEAD" && name !== head)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * The loaded commits `head` has and `base` lacks, newest first, as `git log
 * base..head` lists them. `complete` is false when the walk reached past the
 * loaded history, so the list may be short.
 */
export function between(
  commits: readonly Commit[],
  base: Oid,
  head: Oid,
): { commits: Commit[]; complete: boolean } {
  const index = new Map(
    commits.map((commit, position) => [commit.oid, position]),
  );
  let complete = true;
  const reach = (from: Oid, stop: ReadonlySet<Oid>) => {
    const seen = new Set<Oid>();
    const queue = [from];
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (seen.has(oid) || stop.has(oid)) continue;
      const position = index.get(oid);
      if (position === undefined) {
        complete = false;
        continue;
      }
      seen.add(oid);
      queue.push(...commits[position]!.parents);
    }
    return seen;
  };
  const inBase = reach(base, new Set());
  const ahead = reach(head, inBase);
  return {
    commits: [...ahead]
      .map((oid) => index.get(oid)!)
      .sort((a, b) => a - b)
      .map((position) => commits[position]!),
    complete,
  };
}

/** Where the remote has the head: at its last commit, not at all, missing
 * `ahead` of its commits, with `behind` commits the head lacks, both, or
 * somewhere L1 Git can't place from this clone. */
export type Pushed =
  | { kind: "pushed" }
  | { kind: "missing" }
  | { kind: "ahead"; ahead: number }
  | { kind: "behind"; behind: number }
  | { kind: "diverged" }
  | { kind: "unknown" };

function apart(ahead: number, behind: number): Pushed {
  if (behind === 0) return { kind: "ahead", ahead };
  if (ahead === 0) return { kind: "behind", behind };
  return { kind: "diverged" };
}

/**
 * The counts come from the overview, as Push takes them, when the head
 * tracks `remote`'s copy of it: Git counts them over the whole history.
 * Otherwise, or when the overview hasn't seen the remote move yet, they
 * come from the loaded history, which may stop short of the commits in a
 * large repository, and then the answer is unknown.
 */
export function pushed(
  snapshot: Pick<RepositorySnapshot, "branches" | "commits">,
  remote: string,
  head: OpenHead,
  statuses: readonly BranchStatus[] = [],
): Pushed {
  const there = onRemote(snapshot, remote, head.name);
  if (there === null) return { kind: "missing" };
  if (there === head.oid) return { kind: "pushed" };
  const status = statuses.find(
    (each) =>
      each.reference === `refs/heads/${head.name}` && each.oid === head.oid,
  );
  const counts = status && divergence(status.state);
  if (
    counts?.upstream === `refs/remotes/${remote}/${head.name}` &&
    counts.ahead + counts.behind > 0
  )
    return apart(counts.ahead, counts.behind);
  const ahead = between(snapshot.commits, there, head.oid);
  const behind = between(snapshot.commits, head.oid, there);
  return ahead.complete && behind.complete
    ? apart(ahead.commits.length, behind.commits.length)
    : { kind: "unknown" };
}

/** The subject of the oldest commit, the one the branch starts with. */
export const titleOf = (commits: readonly Commit[]) =>
  commits.at(-1)?.subject ?? "";

/** A commit message without its subject line. */
export function bodyOf(message: string): string {
  const lines = message.replace(/\r\n?/g, "\n").split("\n");
  return lines.slice(1).join("\n").trim();
}

/** What the sidebar's branch menu offers for a branch. */
export type OpenOffer =
  /** `into` is the base GitHub would pick, when L1 Git knows it. */
  | { kind: "open"; into: string | null }
  /** `short` fits beside the item, and `reason` says it in full. */
  | { kind: "off"; short: string; reason: string };

export const SIGN_IN_FIRST: OpenOffer = {
  kind: "off",
  short: "Not signed in",
  reason: "Sign in to GitHub in Settings › Hosts to open pull requests.",
};

export const NOT_ON_GITHUB: OpenOffer = {
  kind: "off",
  short: "Not on GitHub",
  reason: "This repository has no remote on GitHub to open a pull request in.",
};

/** How opening ended, in the words of the notification that says so. */
export const openedText = (number: number, head: string, base: string) =>
  `Opened pull request #${number} from ${head} into ${base}.`;
