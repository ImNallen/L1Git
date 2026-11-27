import { stopText } from "./filesChanged";
import type { Stop } from "./filesChanged";
import type { PullRequest } from "./pullRequest";
import { personName } from "./pullRequestDetail";
import type { RangeFile, SinceReady } from "./range";
import type { GitHubRepository } from "./repository";
import { shortOid } from "./shortOid";
import { markOf } from "./viewedFiles";

export type ReviewPoint = NonNullable<PullRequest["reviewed"]>;

/**
 * Null with no review, on your own pull request, at the reviewed head, or
 * after the base changed since the review. A changed base would replay the old
 * base's commits as the author's.
 */
export function reviewPointOf(
  pull: Pick<PullRequest, "viewerIsAuthor" | "reviewed" | "head" | "timeline">,
): ReviewPoint | null {
  const { reviewed } = pull;
  if (!reviewed || pull.viewerIsAuthor || reviewed.oid === pull.head.oid)
    return null;
  const since = Date.parse(reviewed.at);
  const retargeted = pull.timeline.items.some(
    (event) => event.kind === "baseChanged" && Date.parse(event.at) > since,
  );
  return retargeted ? null : reviewed;
}

/** A file the author changed since your review. `now` is the pull request's file at its path, and null for a file it no longer changes. */
type Again = { since: RangeFile; now: RangeFile | null };
/** A file of the pull request that only the base's changes moved, with the file as you reviewed it. */
type Rebased = { now: RangeFile; reviewed: RangeFile | null };
/** The pull request's files, split by what happened to each since your review. */
export type SinceGroups = {
  again: Again[];
  rebased: Rebased[];
  unchanged: RangeFile[];
};

/**
 * Files are matched by path, and a file renamed since your review by its old
 * path too. A file of the since read that the pull request neither changes now
 * nor changed at your review is the base's own, which an untold read lists,
 * and it is left out.
 */
export function sinceGroups(
  now: readonly RangeFile[],
  { files, reviewed }: Pick<SinceReady, "files" | "reviewed">,
): SinceGroups {
  const nowAt = new Map(now.map((file) => [file.path, file]));
  const reviewedAt = new Map(reviewed.map((file) => [file.path, file]));
  const wasReviewed = new Set(
    reviewed.flatMap(({ path, from }) =>
      from === null ? [path] : [path, from],
    ),
  );
  const changed = new Set<RangeFile>();
  const again = files.flatMap((since): Again[] => {
    const file = nowAt.get(since.path) ?? null;
    // When the pull request's own read doesn't pair a rename since your
    // review, it lists the old path as deleted, and that changed again too.
    const old = since.from === null ? undefined : nowAt.get(since.from);
    if (file === null && old === undefined && !wasReviewed.has(since.path))
      return [];
    for (const claimed of [file, old]) if (claimed) changed.add(claimed);
    return [{ since, now: file }];
  });
  const rebased: Rebased[] = [];
  const unchanged: RangeFile[] = [];
  for (const file of now) {
    if (changed.has(file)) continue;
    const before = reviewedAt.get(file.path) ?? null;
    if (before !== null && markOf(before) === markOf(file))
      unchanged.push(file);
    else rebased.push({ now: file, reviewed: before });
  }
  return { again, rebased, unchanged };
}

/** Who pushed over the head after your review, or null when nobody did. */
function forcePushedAfter(
  { timeline }: Pick<PullRequest, "timeline">,
  point: ReviewPoint,
): string | null {
  const since = Date.parse(point.at);
  const pushed = timeline.items.findLast(
    (event) => event.kind === "forcePushed" && Date.parse(event.at) > since,
  );
  return pushed?.by ?? null;
}

const untoldWhy = {
  shallow: "This clone is shallow.",
  conflict: "Git couldn't settle a conflict replaying your review.",
  unreadable: "Git couldn't read every file it needed.",
} as const;

/** What the since view says of the base branch, or null when it did not move. */
export function baseWords(
  fromBase: SinceReady["fromBase"],
  pull: Pick<PullRequest, "base" | "timeline">,
  point: ReviewPoint,
  viewer: string,
): string | null {
  switch (fromBase.kind) {
    case "none":
      return null;
    case "leftOut": {
      const by = forcePushedAfter(pull, point);
      return by === null
        ? `${pull.base} was merged in after your review.`
        : `${personName(by, viewer)} rebased onto ${pull.base} after your review.`;
    }
    case "untold":
      return `${pull.base} also changed since your review, and its changes show here too. ${untoldWhy[fromBase.why]}`;
    default: {
      const exhaustive: never = fromBase;
      return exhaustive;
    }
  }
}

/** Why there is nothing to compare with your review. */
export type SinceStop = Stop | { kind: "gone" };

/** Why All changes shows in place of what changed since your review. */
export function sinceStopText(
  stop: SinceStop,
  point: ReviewPoint,
  github: GitHubRepository,
): { text: string; detail: string | null; retry: boolean } {
  if (stop.kind === "gone" || point.oid === null)
    return {
      text: "Your review was of a commit GitHub no longer has, so this shows all changes.",
      detail: null,
      retry: false,
    };
  const { title, detail, retry } = stopText(stop, github);
  const isFetch =
    stop.kind === "stillMissing" ||
    stop.kind === "noRemote" ||
    stop.kind === "failed";
  return {
    text: isFetch
      ? `Couldn't get ${shortOid(point.oid)}, the commit you reviewed, so this shows all changes.`
      : "Couldn't compare with your last review, so this shows all changes.",
    detail: detail ?? title,
    retry,
  };
}
