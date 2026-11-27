import type { PullRequest } from "./pullRequest";

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
