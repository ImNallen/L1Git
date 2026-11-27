import type { PullRequest, ReviewState } from "./pullRequest";
import { countsOf } from "./pullRequestChecks";
import type { CheckState } from "./pullRequestChecks";
import { counted, mergedEvent, named, reviewers } from "./pullRequestDetail";
import { mergeChoices } from "./pullRequestMerge";
import type { LocalDelete, MergeMethod } from "./pullRequestMerge";
import type { Oid } from "./repository";
import { shortOid } from "./shortOid";

type MergeKind =
  | "merged"
  | "merging"
  | "failed"
  | "checking"
  | "closed"
  | "draft"
  | "readOnly"
  | "conflicts"
  | "changesRequested"
  | "reviewRequired"
  | "requiredFailing"
  | "behind"
  | "blocked"
  | "failing"
  | "running"
  | "ready"
  | "unknown";
/** The one button the merge box shows. */
type MergeAction =
  | { kind: "none" }
  /** Someone has to act on GitHub before it can merge. */
  | { kind: "openOnGitHub" }
  /** `anyway` when a check failed that isn't required. */
  | { kind: "merge"; anyway: boolean }
  | { kind: "merging" }
  /** Puts away what the last merge said. */
  | { kind: "retry" }
  /** The head branch a merge L1 Git never saw left on GitHub. */
  | { kind: "deleteRemote"; branch: string }
  | { kind: "deleteLocal" };
export type MergeBox = {
  kind: MergeKind;
  title: string;
  text: string;
  action: MergeAction;
};

const roles: Partial<Record<PullRequest["viewerPermission"], string>> = {
  read: "Read",
  triage: "Triage",
};

/** GitHub lets these roles merge where no rule stands in the way. */
const canMerge = ({ viewerPermission }: PullRequest) =>
  viewerPermission === "admin" ||
  viewerPermission === "maintain" ||
  viewerPermission === "write";

/**
 * Whether it can merge and what stands in the way. The first that applies
 * wins, and it claims only what GitHub reports: L1 Git sees no branch rules.
 */
export function mergeBox(
  pull: PullRequest,
  viewer: string | null,
  ago: (at: string) => string,
): MergeBox {
  const box = verdict(pull, viewer, ago);
  if (box.action.kind !== "merge" || canMerge(pull)) return box;
  return {
    ...box,
    text: `${box.text} GitHub didn't say whether you can merge here.`,
    action: { kind: "openOnGitHub" },
  };
}

/** What the read says, before the viewer's role is weighed. */
function verdict(
  pull: PullRequest,
  viewer: string | null,
  ago: (at: string) => string,
): MergeBox {
  const { state, base, mergeable, mergeState } = pull;
  const checks = pull.checks?.items ?? [];
  const whole = pull.checks !== null && checks.length >= pull.checks.total;
  const { passed, failed, running, total } = countsOf(checks);
  const people = (wanted: ReviewState) =>
    reviewers(pull, viewer)
      .filter(({ state }) => state === wanted)
      .map(({ name }) =>
        name === "You" || name === "A team" ? name.toLowerCase() : name,
      );
  const required = (wanted: CheckState) =>
    checks.filter((check) => check.required && check.state === wanted);
  const blocked = mergeState === "blocked";
  const open =
    mergeable === "mergeable" &&
    (mergeState === "clean" ||
      mergeState === "unstable" ||
      mergeState === "hasHooks");
  const unsaid = "GitHub hasn't said yet whether this can merge.";
  const none: MergeAction = { kind: "none" };
  const onGitHub: MergeAction = { kind: "openOnGitHub" };
  // A login keeps its own letters, at the start of a sentence too.
  const sentence = (text: string) =>
    /^(?:a team|you|approved|all|the)\b/.test(text)
      ? text.charAt(0).toUpperCase() + text.slice(1)
      : text;

  if (state.kind === "merged") {
    const merged = mergedEvent(pull);
    return {
      kind: "merged",
      title: `Merged into ${base}`,
      text: merged?.oid
        ? `Merged as ${shortOid(merged.oid)} ${ago(state.at)}.`
        : `Merged ${ago(state.at)}.`,
      action: none,
    };
  }
  if (state.kind === "closed")
    return {
      kind: "closed",
      title: "Closed",
      text: `Closed without merging ${ago(state.at)}.`,
      action: none,
    };
  if (state.draft)
    return {
      kind: "draft",
      title: "Draft",
      text: "Code owners aren't asked to review yet. It can't merge while it's a draft.",
      action: onGitHub,
    };
  const role = roles[pull.viewerPermission];
  if (role)
    return {
      kind: "readOnly",
      title: "You can't merge here",
      text: `Your role in this repository is ${role}. Someone with Write access can merge.`,
      action: none,
    };
  if (mergeable === "conflicting" || mergeState === "dirty")
    return {
      kind: "conflicts",
      title: `Conflicts with ${base}`,
      text: "The conflicts have to be resolved before this can merge.",
      action: onGitHub,
    };
  const refusing = people("changesRequested");
  if (refusing.length > 0)
    return {
      kind: "changesRequested",
      title: "Changes requested",
      text: sentence(
        `${named(refusing)} asked for changes${blocked ? ", and GitHub is blocking the merge" : ""}.`,
      ),
      action: onGitHub,
    };
  const requiredFailed = required("failed");
  const requiredRunning = required("running");
  const asked = people("requested");
  const approved = people("approved");
  // A failing or running required check explains the block by itself.
  if (
    blocked &&
    requiredFailed.length === 0 &&
    requiredRunning.length === 0 &&
    asked.length > 0
  )
    return {
      kind: "reviewRequired",
      title: "Review required",
      text: `GitHub is blocking the merge. Waiting for ${named(asked)} to review.`,
      action: onGitHub,
    };
  if (requiredFailed.length > 0)
    return {
      kind: "requiredFailing",
      title: `${counted(requiredFailed.length, "required check is", "required checks are")} failing`,
      text: `${named(requiredFailed.map(({ name }) => name))} must pass before this can merge.`,
      action: onGitHub,
    };
  if (mergeState === "behind")
    return {
      kind: "behind",
      title: `Behind ${base}`,
      text: `${base} only accepts branches that are up to date with it.`,
      action: onGitHub,
    };
  if (blocked && requiredRunning.length === 0)
    return {
      kind: "blocked",
      title: "Merging is blocked",
      text:
        approved.length === 0
          ? "GitHub is blocking the merge, and nobody has approved this yet."
          : "GitHub is blocking the merge and doesn't tell L1 Git which rule asks for more.",
      action: onGitHub,
    };
  const waits = (otherwise: string) => {
    if (requiredRunning.length > 0)
      return `Merging waits for ${counted(requiredRunning.length, "required check")}.`;
    return open ? otherwise : unsaid;
  };
  if (failed > 0)
    return {
      kind: "failing",
      title: `${counted(failed, "check is", "checks are")} failing`,
      text: waits(
        whole
          ? `None of them is required on ${base}, so this can still merge.`
          : "This can still merge.",
      ),
      action:
        open && requiredRunning.length === 0
          ? { kind: "merge", anyway: true }
          : none,
    };
  if (running > 0)
    return {
      kind: "running",
      title: whole
        ? `${(total - running).toLocaleString()} of ${counted(total, "check")} done`
        : `${counted(running, "check is", "checks are")} running`,
      text: waits(
        whole
          ? "None of the others is required, so this can merge now."
          : "This can merge now.",
      ),
      action:
        open && requiredRunning.length === 0
          ? { kind: "merge", anyway: false }
          : none,
    };
  if (open && mergeState === "unstable" && !whole)
    return {
      kind: "unknown",
      title: "A check hasn't passed",
      text: "It isn't required, so this can still merge. L1 Git can't see which one it is.",
      action: { kind: "merge", anyway: true },
    };
  if (open) {
    const all =
      whole && total > 0 && passed === total
        ? total === 1
          ? "the only check passed"
          : `all ${total.toLocaleString()} checks passed`
        : null;
    const by = approved.length > 0 ? `approved by ${named(approved)}` : null;
    return {
      kind: "ready",
      title: "Ready to merge",
      text: sentence(
        `${by && all ? `${by}, and ${all}` : (by ?? all ?? "GitHub finds nothing that stops it")}.`,
      ),
      action: { kind: "merge", anyway: false },
    };
  }
  return {
    kind: "unknown",
    title: "Can't tell yet",
    text: unsaid,
    action: none,
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
  /** The head branch the user asked L1 Git to delete and it hasn't. */
  headLeft: string | null,
): MergeBox {
  const read = mergeBox(pull, viewer, ago);
  const { base } = pull;
  const { head } = pull;
  const gone =
    head.ref === null && !head.crossRepository
      ? ` ${head.branch} was deleted on GitHub.`
      : "";
  const left =
    headLeft === null
      ? ""
      : ` L1 Git got no answer to the merge, so it didn't delete ${headLeft} on GitHub.`;
  const still =
    local.kind === "offer"
      ? ` Your local branch ${local.name} is still here.`
      : "";
  const after: MergeAction =
    headLeft !== null
      ? { kind: "deleteRemote", branch: headLeft }
      : local.kind === "offer"
        ? { kind: "deleteLocal" }
        : { kind: "none" };
  const merged = (text: string): MergeBox => ({
    kind: "merged",
    title: `Merged into ${base}`,
    text: `${text}${gone}${left}${still}`,
    action: after,
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
