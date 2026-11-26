import { z } from "zod";
import type { PullRequest, ReviewState, ReviewThread } from "./pullRequest";
import type { Oid } from "./repository";

type Side = "left" | "right";
/** GitHub's terms: `side` and `line` are the range's last line, and `start`
 * its first when the range spans more than one. */
type Lines = {
  path: string;
  side: Side;
  line: number;
  start: { side: Side; line: number } | null;
};
type ReviewEvent = "comment" | "approve" | "requestChanges";
type MergeMethod = "merge" | "squash" | "rebase";
type PullId = PullRequest["id"];

/** One click's change on GitHub, as `writes::Write` in the host takes it. The
 * host picks the mutation. */
export type PullWrite =
  | {
      kind: "singleComment";
      pull: PullId;
      commit: Oid;
      lines: Lines;
      body: string;
    }
  | {
      kind: "submitReview";
      pull: PullId;
      commit: Oid;
      event: ReviewEvent;
      body: string;
      threads: readonly { lines: Lines; body: string }[];
    }
  /** The viewer's pending review from github.com, as it is there. */
  | {
      kind: "submitPending";
      review: Extract<PullRequest["pending"], { kind: "review" }>["id"];
      event: ReviewEvent;
      body: string;
    }
  | { kind: "reply"; thread: string; body: string }
  | { kind: "resolve"; thread: string }
  | { kind: "unresolve"; thread: string }
  | { kind: "comment"; pull: PullId; body: string }
  /** A null headline or body is GitHub's own. */
  | {
      kind: "merge";
      pull: PullId;
      expectedHead: Oid;
      method: MergeMethod;
      headline: string | null;
      body: string | null;
    }
  | {
      kind: "deleteHeadBranch";
      pull: PullId;
      branch: string;
      expectedHead: Oid;
    };

const id = z.string().nullable();
const echoSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("review"), id }),
  z.object({ kind: z.literal("comment"), id }),
  z.object({
    kind: z.literal("thread"),
    id,
    resolved: z.boolean().nullable(),
  }),
  z.object({ kind: z.literal("merged"), commit: id }),
  z.object({ kind: z.literal("branchDeleted") }),
]);

/** How a write ended, as the host tells it. */
export const writtenSchema = z.discriminatedUnion("kind", [
  /** GitHub did it, and `echo` holds the ids it gave back. */
  z.object({ kind: z.literal("done"), echo: echoSchema }),
  /** Nothing reached GitHub, so it is safe to send again. */
  z.object({ kind: z.literal("notSent"), message: z.string() }),
  /** GitHub answered and did not do it. */
  z.object({ kind: z.literal("refused"), message: z.string() }),
  /** It left and no answer says whether GitHub did it. Only a read can. */
  z.object({ kind: z.literal("unknown"), message: z.string() }),
]);
export type Written = z.infer<typeof writtenSchema>;

/** How far apart this computer's clock and GitHub's may be. */
const CLOCK_SKEW_MS = 10 * 60_000;

/** GitHub may store line endings and outer spaces other than as typed. */
const sameText = (a: string, b: string) => {
  const plain = (text: string) => text.replace(/\r\n?/g, "\n").trim();
  return plain(a) === plain(b);
};

type Said = { body: string; by: string | null; at: string };
/** Words by `viewer` that GitHub made no earlier than `since` allows. */
const said = (body: string, since: number, viewer: string) => (said: Said) =>
  sameText(said.body, body) &&
  said.by?.toLowerCase() === viewer.toLowerCase() &&
  Date.parse(said.at) >= since - CLOCK_SKEW_MS;

/** A page GitHub cut short may hold what was asked about past its end. */
const complete = (page: { items: readonly unknown[]; total: number }) =>
  page.items.length >= page.total;

function threadOf(
  pull: PullRequest,
  thread: string,
): ReviewThread | null | undefined {
  const found = pull.threads?.items.find((each) => each.id === thread);
  if (found) return found;
  return pull.threads && complete(pull.threads) ? null : undefined;
}

/** True when the read shows it, false when it shows it did not happen, and
 * null when the read cannot say. */
type Landed<W extends PullWrite> = (
  write: W,
  pull: PullRequest,
  since: number,
  viewer: string,
) => boolean | null;

const verdicts: Record<ReviewEvent, ReviewState> = {
  comment: "commented",
  approve: "approved",
  requestChanges: "changesRequested",
};

function threadsSay(
  pull: PullRequest,
  path: string,
  words: (comment: Said) => boolean,
): boolean | null {
  const threads = pull.threads;
  if (threads === null) return null;
  const here = threads.items.filter((thread) => thread.path === path);
  if (here.some((thread) => thread.comments.items.some(words))) return true;
  const whole =
    complete(threads) && here.every((thread) => complete(thread.comments));
  return whole ? false : null;
}

const resolvedIs =
  (
    resolved: boolean,
  ): Landed<Extract<PullWrite, { kind: "resolve" | "unresolve" }>> =>
  ({ thread }, pull) => {
    const found = threadOf(pull, thread);
    return found === undefined ? null : found?.resolved === resolved;
  };

/**
 * How a read tells whether each write landed, which settles one whose outcome
 * is unknown. A mapped type, so a new kind of write without its own `landed`
 * does not build.
 */
const deeds: {
  [K in PullWrite["kind"]]: { landed: Landed<Extract<PullWrite, { kind: K }>> };
} = {
  singleComment: {
    landed: ({ lines, body }, pull, since, viewer) =>
      threadsSay(pull, lines.path, said(body, since, viewer)),
  },
  submitReview: {
    landed: ({ event, body }, pull, since, viewer) =>
      pull.timeline.items.some(
        (item) =>
          item.kind === "review" &&
          item.state === verdicts[event] &&
          said(body, since, viewer)(item),
      ),
  },
  submitPending: {
    landed: ({ review }, pull) => {
      if (pull.timeline.items.some((event) => event.id === review)) return true;
      const { pending } = pull;
      if (pending.kind === "review" && pending.id === review) return false;
      return pending.kind === "unknown" ? null : false;
    },
  },
  reply: {
    landed: ({ thread, body }, pull, since, viewer) => {
      const found = threadOf(pull, thread);
      if (!found) return found === null ? false : null;
      if (found.comments.items.some(said(body, since, viewer))) return true;
      return complete(found.comments) ? false : null;
    },
  },
  resolve: { landed: resolvedIs(true) },
  unresolve: { landed: resolvedIs(false) },
  comment: {
    landed: ({ body }, pull, since, viewer) =>
      pull.timeline.items.some(
        (item) => item.kind === "comment" && said(body, since, viewer)(item),
      ),
  },
  merge: { landed: (_, pull) => pull.state.kind === "merged" },
  deleteHeadBranch: { landed: (_, pull) => pull.head.ref === null },
};

export const landed = <W extends PullWrite>(
  write: W,
  pull: PullRequest,
  since: number,
  viewer: string,
): boolean | null =>
  (deeds[write.kind].landed as Landed<W>)(write, pull, since, viewer);
