import type { createPullRequestWrites } from "../pullRequestWrites";

type Writes = ReturnType<typeof createPullRequestWrites>;

/** Each answer of the writes store that sent nothing. */
export type SentNothing = Exclude<
  ReturnType<Writes["send"]> | ReturnType<Writes["sendAnyway"]>,
  "started"
>;

/** Why a click sent nothing, the same wherever it was sent from. */
export const sentNothing: Record<SentNothing, string> = {
  busy: "Another write to this pull request is still sending, or may have posted, so L1 Git sent nothing. Try again once that one ends.",
  unsaved:
    "L1 Git couldn't save your words on this computer first, so it sent nothing.",
  signedOut: "L1 Git isn't signed in to GitHub, so it sent nothing.",
  restarting:
    "L1 Git is restarting to update, so it sent nothing. Try again once it restarts.",
  notInRead:
    "L1 Git's latest read of this pull request doesn't match this, so it sent nothing. Refresh the pull request and try again.",
  gone: "It isn't waiting to be sent anymore, so L1 Git sent nothing.",
};

/** Keep as draft gave nothing back. */
export const keptNothing =
  "L1 Git couldn't keep it as a draft, so nothing changed. Try again in a moment.";
