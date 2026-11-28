import type {
  Branch,
  Commit,
  GitHubRepository,
  Head,
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

/** What has to happen before GitHub can open a pull request from the head:
 * nothing, publishing it or pushing to it with the user's Git credentials,
 * or something L1 Git doesn't do, which `message` says. */
export type FirstStep =
  | { kind: "none" }
  | { kind: "publish"; message: string }
  | { kind: "push"; message: string }
  | { kind: "blocked"; message: string };

const commitsOf = (count: number) =>
  count === 1 ? "1 commit" : `${count.toLocaleString()} commits`;

/** Where the head is checked out: in the worktree the popover opened in,
 * in another one, named, or nowhere. */
export type Checkout =
  | { kind: "here" }
  | { kind: "elsewhere"; worktree: string }
  | { kind: "nowhere" };

/** The branch's checkout: the snapshot's head, or another worktree's. */
export function checkoutOf(
  snapshot: Pick<RepositorySnapshot, "head" | "worktrees">,
  head: string,
): Checkout {
  const reference = `refs/heads/${head}`;
  const at = (checkedOut: Head) =>
    checkedOut.kind === "attached" && checkedOut.reference === reference;
  if (at(snapshot.head)) return { kind: "here" };
  const other = snapshot.worktrees.find(
    (worktree) => !worktree.current && at(worktree.head),
  );
  return other
    ? { kind: "elsewhere", worktree: other.name }
    : { kind: "nowhere" };
}

/** An upstream ref as Git names it short: `origin/main`, or `main` for a
 * local branch. */
const shortUpstream = (upstream: string) =>
  upstream.replace(/^refs\/(remotes|heads)\//, "");

/**
 * L1 Git publishes or pushes only the branch checked out where it opened,
 * as the toolbar's Push does, and never force-pushes. It decides as the
 * core does, from the branch's upstream: it publishes only a branch with
 * none, and pushes only one whose upstream is `remote`'s branch of the same
 * name, so the push lands on the branch GitHub opens from.
 */
export function firstStep(
  state: Pushed,
  {
    head,
    remote,
    upstream,
    checkout,
  }: {
    head: string;
    remote: string;
    upstream: string | null;
    checkout: Checkout;
  },
): FirstStep {
  const blocked = (message: string): FirstStep => ({
    kind: "blocked",
    message,
  });
  switch (state.kind) {
    case "pushed":
      return { kind: "none" };
    case "behind":
      return blocked(
        `${remote}/${head} has ${commitsOf(state.behind)} that ${head} doesn't. Pull first, so the pull request shows what you see here.`,
      );
    case "diverged":
      return blocked(
        `${head} and ${remote}/${head} have each moved on. Pull and push first, then open the pull request.`,
      );
    case "unknown":
      return blocked(
        `${remote}/${head} is at another commit than ${head}, and L1 Git can't tell which is ahead from the history it loaded. Make them match in Git, then open the pull request.`,
      );
  }
  const lacking =
    state.kind === "missing"
      ? `${head} isn't on ${remote} yet.`
      : `${remote} doesn't have ${commitsOf(state.ahead)} of ${head} yet.`;
  const tracked = `refs/remotes/${remote}/${head}`;
  if (upstream !== null && upstream !== tracked)
    return blocked(
      `${lacking} ${head} tracks ${shortUpstream(upstream)}, so L1 Git can't publish it as ${head} on ${remote}. Push it there in Git first, then open the pull request.`,
    );
  const kind = upstream === null ? "publish" : "push";
  const verb = kind === "publish" ? "publish it" : "push";
  switch (checkout.kind) {
    case "nowhere":
      return blocked(
        `${lacking} Check it out to ${verb}, then open the pull request.`,
      );
    case "elsewhere":
      return blocked(
        `${lacking} It's checked out in the worktree ${checkout.worktree}. Switch to that worktree to ${verb}, then open the pull request.`,
      );
    case "here":
      return {
        kind,
        message: `${lacking} L1 Git ${kind === "publish" ? "publishes it" : "pushes"} first, with your Git credentials, then opens the pull request.`,
      };
  }
}

/** GitHub's longest title, and the longest description L1 Git sends. */
const TITLE_CHARS = 256;
const BODY_CHARS = 65_536;

/** What the host would refuse to open before it sends anything, in its
 * words, so L1 Git can tell before it publishes or pushes for nothing. */
export function unopenable(open: {
  title: string;
  body: string;
  head: string;
  base: string;
}): string | null {
  const title = open.title.trim();
  if (title === "" || [...title].length > TITLE_CHARS)
    return `A pull request needs a title of at most ${TITLE_CHARS} characters.`;
  if ([...open.body].length > BODY_CHARS)
    return `A description holds at most ${BODY_CHARS.toLocaleString("en-US")} characters.`;
  if (
    open.head.trim() === "" ||
    open.base.trim() === "" ||
    open.head === open.base
  )
    return "A pull request merges one branch into another.";
  return null;
}

/** Why the host wouldn't open as `login`, the account the popover opened
 * with, now that GitHub is `now`. */
export function signedInProblem(
  login: string,
  now: string | null,
): string | null {
  if (now === null)
    return "L1 Git is not connected to GitHub. Sign in from Settings › Hosts.";
  return now.toLowerCase() === login.toLowerCase()
    ? null
    : `L1 Git is signed in to GitHub as ${now}, not ${login}.`;
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
