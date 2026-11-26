import type { PullCheckout, PullHead } from "../domain/pullRequestCheckout";
import {
  pullCheckoutSchema,
  pullHeadSchema,
  pullKeySchema,
} from "../domain/pullRequestCheckout";
import type { FullRef, Oid, RepositoryRoot } from "../domain/repository";
import { Refusal, fromHome, known } from "./fakeBridge";
import type { BridgeRequest, Handler, World } from "./fakeBridge";
import { addLinkedWorktree, removeLinkedWorktree } from "./fixtures";

type Operation = Extract<
  Extract<PullCheckout, { kind: "ready" }>["worktree"]["changes"],
  { kind: "inProgress" }
>["operation"];

/** `pr/<number>` at `tip`, and the worktree that has it checked out. */
export type PullCopy = {
  tip: string;
  worktree: {
    root: RepositoryRoot;
    main: boolean;
    operation?: Operation;
  } | null;
};

function pullCopy(request: BridgeRequest, world: World) {
  const pull = pullKeySchema.parse(request.pull);
  const head = pullHeadSchema.parse(request.head);
  const opened = known(world.snapshots, request.path);
  const main = opened.worktrees.find((worktree) => worktree.main) ?? opened;
  const key = `${main.root} #${pull.number}`;
  const name = `pr/${pull.number}`;
  const answer = (): PullCheckout => {
    const branch = `refs/heads/${name}`;
    const parent = main.root.split("/").slice(0, -1).join("/");
    const plan = {
      folder: `${parent}/.worktrees/${main.name}-pr-${pull.number}`,
      pushes: pushesOf(head),
    };
    const copy = world.pullCopies.get(key);
    if (!copy)
      return pullCheckoutSchema.parse({ kind: "absent", branch, plan });
    const { tip, worktree } = copy;
    const relation = relationOf(world, tip, head.oid);
    if (!worktree)
      return pullCheckoutSchema.parse({
        kind: "parked",
        branch,
        tip,
        relation,
        plan,
      });
    const { root, operation } = worktree;
    const entries = world.statuses.get(root)?.entries;
    return pullCheckoutSchema.parse({
      kind: "ready",
      branch,
      tip,
      relation,
      worktree: {
        root,
        name: root.split("/").at(-1),
        main: worktree.main,
        changes: !entries
          ? { kind: "missing" }
          : operation
            ? { kind: "inProgress", operation }
            : { kind: entries.length > 0 ? "uncommitted" : "clean" },
        trouble: null,
      },
    });
  };
  const keep = (copy: PullCopy | null) => {
    for (const [root, snapshot] of world.snapshots)
      if (snapshot.worktrees.some((worktree) => worktree.root === main.root))
        world.snapshots.set(root, {
          ...snapshot,
          branches: [
            ...snapshot.branches.filter((listed) => listed.name !== name),
            ...(copy
              ? [
                  {
                    kind: "local" as const,
                    reference: `refs/heads/${name}` as FullRef,
                    name,
                    oid: copy.tip as Oid,
                    upstream: null,
                  },
                ]
              : []),
          ],
        });
    if (copy) world.pullCopies.set(key, copy);
    else world.pullCopies.delete(key);
    return answer();
  };
  const seen = () => {
    const copy = world.pullCopies.get(key);
    if (!copy || copy.tip !== request.seen)
      throw new Refusal({
        kind: "staleView",
        reason: "branchChanged",
        message: `${name} is no longer at the commit L1 Git showed, so nothing changed. Refresh and try again.`,
      });
    return copy;
  };
  const fetch = () => {
    let at: string | undefined = head.oid;
    while (at !== undefined) {
      const commit = world.pullCommits.get(at);
      if (!commit || commit.fetched) break;
      world.pullCommits.set(at, { ...commit, fetched: true });
      at = commit.parent;
    }
  };
  const copy = world.pullCopies.get(key);
  return { head, name, copy, answer, keep, seen, fetch };
}

/** How `tip` stands against `head`, walking each down `pullCommits`. */
function relationOf(world: World, tip: string, head: string) {
  const line = (oid: string) => {
    const commits = [oid];
    for (
      let at = world.pullCommits.get(oid)?.parent;
      at !== undefined && !commits.includes(at);
      at = world.pullCommits.get(at)?.parent
    )
      commits.push(at);
    return commits;
  };
  const mine = line(tip);
  if (!mine.includes(head) && !world.pullCommits.get(head)?.fetched)
    return { kind: "unfetched" };
  const theirs = line(head);
  const base = theirs.findIndex((oid) => mine.includes(oid));
  const ahead = base === -1 ? mine.length : mine.indexOf(theirs[base]!);
  const behind = base === -1 ? theirs.length : base;
  if (ahead > 0 && behind > 0) return { kind: "diverged", ahead, behind };
  if (ahead > 0) return { kind: "ahead", commits: ahead };
  if (behind > 0) return { kind: "behind", commits: behind };
  return { kind: "upToDate" };
}

function pushesOf(head: PullHead) {
  const { from } = head;
  if (from.kind === "same" && from.edits)
    return {
      kind: "toPullRequest",
      remote: "origin",
      destination: head.reference,
      addsRemote: false,
    };
  if (from.kind === "fork" && from.edits)
    return {
      kind: "toPullRequest",
      remote: from.repository.owner,
      destination: head.reference,
      addsRemote: true,
    };
  return {
    kind: "nowhere",
    why: { same: "readOnly", fork: "noEdits", gone: "forkGone" }[from.kind],
  };
}

export const pullCopyHandlers: Record<string, Handler> = {
  pullCheckout: (request, world) => pullCopy(request, world).answer(),
  tryPullRequest: (request, world) => {
    const { head, name, copy, answer, keep, fetch } = pullCopy(request, world);
    fetch();
    if (copy?.worktree) return answer();
    const root = fromHome(String(request.folder)) as RepositoryRoot;
    keep({ tip: copy?.tip ?? head.oid, worktree: { root, main: false } });
    addLinkedWorktree(world, request.path as RepositoryRoot, root, name);
    return answer();
  },
  updatePullRequest: (request, world) => {
    const { head, name, answer, keep, seen, fetch } = pullCopy(request, world);
    fetch();
    const copy = seen();
    const relation = relationOf(world, copy.tip, head.oid);
    if (relation.kind === "unfetched")
      throw new Refusal({
        kind: "staleView",
        reason: "branchChanged",
        message:
          "The pull request changed on GitHub since L1 Git read it, so nothing changed. Refresh it and try again.",
      });
    if (relation.kind === "diverged" && request.replace !== true)
      throw new Refusal({
        kind: "conflict",
        message: `${name} has ${relation.ahead === 1 ? "1 commit" : `${relation.ahead} commits`} the pull request does not, so L1 Git did not move it. Replace it with the pull request to leave them behind.`,
      });
    if (relation.kind === "ahead" && request.replace !== true) return answer();
    return keep({ ...copy, tip: head.oid });
  },
  removePullRequest: (request, world) => {
    const { head, copy, answer, keep, seen, fetch } = pullCopy(request, world);
    fetch();
    if (!copy) return answer();
    seen();
    const ready = answer();
    if (ready.kind === "ready") {
      const { root, name, main, changes } = ready.worktree;
      const refused = (kind: "conflict" | "unsupportedPath", message: string) =>
        new Refusal({ kind, message });
      if (main)
        throw refused(
          "unsupportedPath",
          `${name} is this repository's main worktree, and Git removes only linked worktrees.`,
        );
      if (changes.kind === "inProgress")
        throw refused(
          "conflict",
          `An operation is in progress in ${name}. Finish or abort it there, then remove the worktree.`,
        );
      if (changes.kind === "uncommitted")
        throw refused(
          "conflict",
          `${name} has uncommitted or untracked files. Commit, stash, or discard them there, then remove the worktree.`,
        );
      removeLinkedWorktree(world, root as RepositoryRoot);
    }
    const { kind } = relationOf(world, copy.tip, head.oid);
    return keep(
      kind === "upToDate" || kind === "behind"
        ? null
        : { ...copy, worktree: null },
    );
  },
};
