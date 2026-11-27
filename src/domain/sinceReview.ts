import type { PullRequest } from "./pullRequest";

export type ReviewPoint = NonNullable<PullRequest["reviewed"]>;

/** Null with no review, on your own pull request, or at the reviewed head. */
export function reviewPointOf(
  pull: Pick<PullRequest, "viewerIsAuthor" | "reviewed" | "head">,
): ReviewPoint | null {
  const { reviewed } = pull;
  if (!reviewed || pull.viewerIsAuthor || reviewed.oid === pull.head.oid)
    return null;
  return reviewed;
}
