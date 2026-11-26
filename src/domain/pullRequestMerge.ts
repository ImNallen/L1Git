import type { BranchStatus } from "./overview";
import type { PullRequest } from "./pullRequest";
import type { PullCheckout } from "./pullRequestCheckout";
import { counted, mergeBox } from "./pullRequestDetail";
import type { MergeBox } from "./pullRequestDetail";
import type { PullWrite } from "./pullRequestWrites";
import { shortBranch } from "./refs";
import { branchTipSchema } from "./repository";
import type { BranchTip, Oid } from "./repository";
import { shortOid } from "./shortOid";

export type MergeMethod = PullRequest["merge"]["preferred"];
export type MergeWrite = Extract<PullWrite, { kind: "merge" }>;

/** GitHub's three ways to merge, in the popover's order. */
const methods: Record<
  MergeMethod,
  {
    label: string;
    verb: string;
    busy: string;
    note: (pull: PullRequest) => string;
  }
> = {
  squash: {
    label: "Squash and merge",
    verb: "Squash and merge",
    busy: "Squashing and merging…",
    note: ({ base }) => `One commit on ${base}.`,
  },
  merge: {
    label: "Create a merge commit",
    verb: "Merge",
    busy: "Merging…",
    note: ({ commits }) =>
      `Keeps ${commits.total === 1 ? "the commit" : `all ${commits.total.toLocaleString()} commits`} and adds a merge commit.`,
  },
  rebase: {
    label: "Rebase and merge",
    verb: "Rebase and merge",
    busy: "Rebasing and merging…",
    note: ({ base, commits }) =>
      `Puts ${commits.total === 1 ? "the commit" : `the ${commits.total.toLocaleString()} commits`} on ${base} one by one.`,
  },
};
const order: readonly MergeMethod[] = ["squash", "merge", "rebase"];

export type MethodChoice = {
  method: MergeMethod;
  label: string;
  note: string;
  off: boolean;
};

/** Each method, with why it is off, and the one to preselect: the last one
 * used in L1 Git, else the repository's, else the first it allows. */
export function mergeChoices(
  pull: PullRequest,
  last: MergeMethod | null,
): { methods: MethodChoice[]; chosen: MergeMethod | null } {
  const { allowed, preferred } = pull.merge;
  const on = order.filter((method) => allowed[method]);
  const chosen =
    [last, preferred].find((method) => method !== null && allowed[method]) ??
    on[0] ??
    null;
  return {
    methods: order.map((method) => ({
      method,
      label: methods[method].label,
      note: !allowed[method]
        ? "Turned off in this repository's settings on GitHub."
        : method === last
          ? `${methods[method].note(pull)} Last used in L1 Git.`
          : methods[method].note(pull),
      off: !allowed[method],
    })),
    chosen,
  };
}

export const mergeLabel = (method: MergeMethod, anyway: boolean) =>
  anyway ? `${methods[method].verb} anyway` : methods[method].verb;

export const mergingLabel = (method: MergeMethod) => methods[method].busy;

/** The commit message as GitHub starts it. A rebase writes no commit. */
export function commitTexts(
  { number, title, body, head }: PullRequest,
  method: MergeMethod,
): { headline: string; body: string } | null {
  switch (method) {
    case "squash":
      return { headline: `${title} (#${number})`, body };
    case "merge":
      return {
        headline: `Merge pull request #${number} from ${head.repository ? `${head.repository.owner}/` : ""}${head.branch}`,
        body: title,
      };
    case "rebase":
      return null;
  }
}

/** After a merge: whether L1 Git can delete the head branch on GitHub. The
 * host checks again, and keeps it when an open pull request merges into it. */
export type RemoteDelete =
  | { kind: "none" }
  | { kind: "off"; note: string }
  /** GitHub deletes it itself, so the box is checked and fixed. */
  | { kind: "github"; note: string }
  | { kind: "offer"; note: string };

export function remoteDelete({ head, merge }: PullRequest): RemoteDelete {
  const { ref, crossRepository, repository } = head;
  if (ref === null) return { kind: "none" };
  if (crossRepository)
    return {
      kind: "off",
      note: repository
        ? `It's in ${repository.owner}/${repository.repo}, a fork.`
        : "It's in a fork.",
    };
  if (ref.othersOpen > 0)
    return {
      kind: "off",
      note: `${counted(ref.othersOpen, "other open pull request uses", "other open pull requests use")} it.`,
    };
  if (merge.deletesBranch)
    return {
      kind: "github",
      note: "GitHub deletes it after the merge, by this repository's settings.",
    };
  if (!ref.viewerCanDelete)
    return { kind: "off", note: "GitHub doesn't let you delete it." };
  return { kind: "offer", note: "No other pull request uses it." };
}

/** The local branch that tracks the pull request, which L1 Git can delete
 * with an undoable write. */
export type LocalDelete =
  | { kind: "none" }
  | { kind: "off"; name: string; note: string }
  | { kind: "offer"; name: string; branch: BranchTip };

const folderName = (root: string) =>
  root
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .at(-1) ?? root;

/**
 * L1 Git's own copy, `pr/<number>`, when there is one. Otherwise the one
 * branch whose upstream is the head on the remote the copy would track.
 */
export function localDelete(
  checkout: PullCheckout | null,
  branches: readonly BranchStatus[],
): LocalDelete {
  if (checkout === null) return { kind: "none" };
  if (checkout.kind !== "absent") {
    const name = shortBranch(checkout.branch);
    if (checkout.kind === "ready")
      return {
        kind: "off",
        name,
        note: `It's checked out in ${checkout.worktree.name}.`,
      };
    if (
      checkout.relation.kind === "ahead" ||
      checkout.relation.kind === "diverged"
    )
      return {
        kind: "off",
        name,
        note: "It has commits that aren't in the pull request.",
      };
    return {
      kind: "offer",
      name,
      branch: { reference: checkout.branch, oid: checkout.tip },
    };
  }
  const { pushes } = checkout.plan;
  if (pushes.kind !== "toPullRequest") return { kind: "none" };
  const upstream = `refs/remotes/${pushes.remote}/${shortBranch(pushes.destination)}`;
  const tracking = branches.filter(
    ({ state }) => state.kind !== "untracked" && state.upstream === upstream,
  );
  const [found] = tracking;
  if (found === undefined || tracking.length > 1) return { kind: "none" };
  const name = shortBranch(found.reference);
  if (found.checkedOutAt !== null)
    return {
      kind: "off",
      name,
      note: `It's checked out in ${folderName(found.checkedOutAt)}.`,
    };
  if (found.state.kind === "ahead" || found.state.kind === "diverged")
    return { kind: "off", name, note: "It has commits that aren't on GitHub." };
  return {
    kind: "offer",
    name,
    branch: branchTipSchema.parse({
      reference: found.reference,
      oid: found.oid,
    }),
  };
}

/** The last merge sent from this window, by how it ended. */
export type MergeProgress =
  | { kind: "idle" }
  | { kind: "sending"; method: MergeMethod }
  | { kind: "done"; commit: string | null }
  /** Sent with no answer. `kept`: the host keeps it, and each read of the
   * pull request looks for it. */
  | { kind: "unknown"; kept: boolean }
  | { kind: "refused"; message: string; expectedHead: Oid }
  | { kind: "notSent"; message: string }
  /** A read after an unknown answer shows it didn't merge. */
  | { kind: "notLanded"; message: string };

/**
 * The merge box as the read and the last merge tell it. A read that shows it
 * merged wins; otherwise the merge in flight, or how it ended, comes first.
 */
export function shownBox(
  pull: PullRequest,
  viewer: string | null,
  ago: (at: string) => string,
  progress: MergeProgress,
  local: LocalDelete,
): MergeBox {
  const read = mergeBox(pull, viewer, ago);
  const { base } = pull;
  const { head } = pull;
  const gone =
    head.ref === null && !head.crossRepository
      ? ` ${head.branch} was deleted on GitHub.`
      : "";
  const still =
    local.kind === "offer"
      ? ` Your local branch ${local.name} is still here.`
      : "";
  const merged = (text: string): MergeBox => ({
    kind: "merged",
    title: `Merged into ${base}`,
    text: `${text}${gone}${still}`,
    action: local.kind === "offer" ? { kind: "deleteLocal" } : { kind: "none" },
  });
  const failed = (title: string, text: string): MergeBox => ({
    kind: "failed",
    title,
    text,
    action: { kind: "retry" },
  });
  if (read.kind === "merged") return merged(read.text);
  switch (progress.kind) {
    case "sending":
      return {
        kind: "merging",
        title: `Merging into ${base}…`,
        text: "This takes a few seconds. You can leave this page.",
        action: { kind: "merging" },
      };
    case "done":
      return merged(
        progress.commit
          ? `Merged as ${shortOid(progress.commit)} just now.`
          : "Merged just now.",
      );
    case "unknown":
      return {
        kind: "checking",
        title: "L1 Git can't tell yet whether this merged",
        text: progress.kept
          ? "GitHub got the merge, and L1 Git got no answer it could read. L1 Git reads the pull request again to find out."
          : "GitHub got the merge, and L1 Git got no answer it could read. If the pull request doesn't read as merged soon, nothing was merged.",
        action: progress.kept ? { kind: "openOnGitHub" } : { kind: "retry" },
      };
    case "refused":
      return failed(
        "GitHub didn't merge this",
        pull.head.oid === progress.expectedHead
          ? `${progress.message} Nothing was merged.`
          : "New commits arrived. Review them, then merge.",
      );
    case "notSent":
      return failed("L1 Git didn't merge this", progress.message);
    case "notLanded":
      return failed("Nothing was merged", progress.message);
    case "idle":
      break;
  }
  if (read.action.kind === "merge" && mergeChoices(pull, null).chosen === null)
    return { ...read, action: { kind: "none" } };
  return read;
}
