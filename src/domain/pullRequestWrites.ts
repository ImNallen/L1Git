import { z } from "zod";
import type { PullRequest } from "./pullRequest";
import { oidSchema } from "./repository";

const nodeId = <Brand extends string>() => z.string().min(1).brand<Brand>();
const sideSchema = z.enum(["left", "right"]);
const lineSchema = z.number().int().positive();
/** GitHub's terms: `side` and `line` are the range's last line, and `start`
 * its first when the range spans more than one. */
const linesSchema = z.object({
  path: z.string().min(1),
  side: sideSchema,
  line: lineSchema,
  start: z.object({ side: sideSchema, line: lineSchema }).nullable(),
});
const eventSchema = z.enum(["comment", "approve", "requestChanges"]);
const pull = nodeId<"PullId">();

/** One click's change on GitHub, as `writes::Write` in the host takes it and
 * keeps it while its outcome is unknown. The host picks the mutation. */
export const pullWriteSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("singleComment"),
    pull,
    commit: oidSchema,
    lines: linesSchema,
    body: z.string(),
  }),
  z.object({
    kind: z.literal("submitReview"),
    pull,
    commit: oidSchema,
    event: eventSchema,
    body: z.string(),
    threads: z.array(z.object({ lines: linesSchema, body: z.string() })),
  }),
  /** The viewer's pending review from github.com, as it is there. */
  z.object({
    kind: z.literal("submitPending"),
    review: nodeId<"ReviewId">(),
    event: eventSchema,
    body: z.string(),
  }),
  z.object({ kind: z.literal("reply"), thread: z.string(), body: z.string() }),
  z.object({ kind: z.literal("resolve"), thread: z.string() }),
  z.object({ kind: z.literal("unresolve"), thread: z.string() }),
  z.object({ kind: z.literal("comment"), pull, body: z.string() }),
  /** A null headline or body is GitHub's own. */
  z.object({
    kind: z.literal("merge"),
    pull,
    expectedHead: oidSchema,
    method: z.enum(["merge", "squash", "rebase"]),
    headline: z.string().nullable(),
    body: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("deleteHeadBranch"),
    pull,
    branch: z.string(),
    expectedHead: oidSchema,
  }),
]);
export type PullWrite = z.infer<typeof pullWriteSchema>;

/** Whether `pull`'s read shows every node `write` names, so a write never
 * reaches another pull request's thread or review. */
export function namedIn(write: PullWrite, pull: PullRequest): boolean {
  switch (write.kind) {
    case "reply":
    case "resolve":
    case "unresolve":
      return pull.threads?.items.some(({ id }) => id === write.thread) ?? false;
    case "submitPending":
      return pull.pending.kind === "review" && pull.pending.id === write.review;
    default:
      return write.pull === pull.id;
  }
}

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
export type Echo = z.infer<typeof echoSchema>;

/** How a write ended, as the host tells it. */
export const writtenSchema = z.discriminatedUnion("kind", [
  /** GitHub did it, and `echo` holds the ids it gave back. */
  z.object({ kind: z.literal("done"), echo: echoSchema }),
  /** Nothing reached GitHub, so it is safe to send again. */
  z.object({ kind: z.literal("notSent"), message: z.string() }),
  /** GitHub answered and did not do it. */
  z.object({ kind: z.literal("refused"), message: z.string() }),
  /** It left and no answer says whether GitHub did it. The host keeps it,
   * and only a read showing what it made can settle it. */
  z.object({ kind: z.literal("unknown"), message: z.string() }),
]);
export type Written = z.infer<typeof writtenSchema>;

/** What a read showed of a write whose outcome was unknown. */
export const seenSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("landed"), echo: echoSchema }),
  /** Only for a write GitHub can do twice without harm, such as resolve or
   * merge: it can be sent again. */
  z.object({ kind: z.literal("notLanded"), message: z.string() }),
]);
