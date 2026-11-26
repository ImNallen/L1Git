import { z } from "zod";
import { pullWriteSchema } from "./pullRequestWrites";
import { oidSchema } from "./repository";
import type { Oid } from "./repository";

const sideSchema = z.enum(["left", "right"]);
const lineSchema = z.number().int().positive();

/** Where a draft's words go. The shape of `drafts::Anchor` in the host. */
const anchorSchema = z.discriminatedUnion("kind", [
  /** GitHub's terms: `side` and `line` are the range's last line, and `start`
   * its first when the range spans more than one. */
  z.object({
    kind: z.literal("line"),
    path: z.string().min(1),
    side: sideSchema,
    line: lineSchema,
    start: z.object({ side: sideSchema, line: lineSchema }).nullable(),
  }),
  z.object({ kind: z.literal("reply"), thread: z.string().min(1) }),
  z.object({ kind: z.literal("conversation") }),
  z.object({ kind: z.literal("summary") }),
  /** The merge commit's message: its first line is the headline. */
  z.object({ kind: z.literal("merge") }),
]);

const draftSchema = z.object({
  anchor: anchorSchema,
  /** The pull request's head when this text was last written. */
  head: oidSchema,
  text: z.string(),
  writtenAt: z.number().int().nonnegative(),
  /** What a change based on this draft names as `at`. */
  savedAt: z.number().int().nonnegative(),
  /** A write carried these words, its answer was lost, and the user kept
   * them as a draft: sending them again may post them twice. */
  mayHavePosted: z.boolean(),
});

/** A write that left, or may have, kept by the host with the drafts it
 * carried from before it left until its outcome is known. */
const sentSchema = z.object({
  attempt: z.string(),
  /** When it last left, in Unix milliseconds. */
  at: z.number(),
  write: pullWriteSchema,
  drafts: z.array(draftSchema),
  /** This L1 Git is sending it now. Otherwise its outcome is unknown: it
   * may have posted. */
  sending: z.boolean(),
});

/** Words typed where a write held the place, kept by the host so a close
 * can't lose them. `on` is the `savedAt` they were typed on. */
const waitingSchema = z.object({
  anchor: anchorSchema,
  head: oidSchema,
  text: z.string(),
  on: z.number().int().nonnegative().nullable(),
});

export const pullDraftsSchema = z.object({
  drafts: z.array(draftSchema),
  refused: z
    .discriminatedUnion("kind", [
      /** Another window wrote since. */
      z.object({ kind: z.literal("stale") }),
      /** A write that left, or may have, holds this place until it is
       * known or kept as a draft. */
      z.object({ kind: z.literal("sent") }),
      /** Its write is still sending, so it can't be kept as a draft yet. */
      z.object({ kind: z.literal("sending") }),
      /** No room for one more, in this pull request's drafts or in the pull
       * requests that have drafts. Nothing is dropped to make room. */
      z.object({
        kind: z.literal("full"),
        of: z.enum(["drafts", "pullRequests"]),
      }),
    ])
    .nullable(),
  /** Where an unreadable drafts file went, on the one answer that moved it
   * aside. The drafts started again without it. */
  setAside: z.string().nullable(),
  sent: z.array(sentSchema),
  /** Until the write ends, or, when typed on another draft than it
   * carried, until a put, delete or forget at their place. */
  waiting: z.array(waitingSchema),
});

export type Anchor = z.infer<typeof anchorSchema>;
export type Draft = z.infer<typeof draftSchema>;
export type PullDrafts = z.infer<typeof pullDraftsSchema>;
export type SentWrite = z.infer<typeof sentSchema>;
export type Waiting = z.infer<typeof waitingSchema>;

export type DraftChange =
  | { kind: "read" }
  | {
      kind: "put";
      anchor: Anchor;
      head: Oid;
      text: string;
      /** The `savedAt` this text is based on, or null for a new draft. */
      at: number | null;
    }
  | { kind: "delete"; anchor: Anchor; head: Oid; at: number }
  /** Keep as draft: gives back a write's drafts, marked as may have posted. */
  | { kind: "keep"; attempt: string }
  /** Drops the words that waited at this place. */
  | { kind: "forget"; anchor: Anchor; head: Oid };

/** GitHub's limit on a comment's body. The host counts Unicode scalar
 * values, so an emoji is one. */
export const mostDraftChars = 65_536;

/** What the host takes as a draft's text. Blank is the host's `str::trim`:
 * only Unicode White_Space. JavaScript's `trim` also drops U+FEFF and keeps
 * U+0085. `crates/host/tests/draft-texts.json` holds the cases both check. */
export function draftText(text: string): "blank" | "tooLong" | "takes" {
  if (/^\p{White_Space}*$/u.test(text)) return "blank";
  if (text.length > mostDraftChars && [...text].length > mostDraftChars)
    return "tooLong";
  return "takes";
}

/** A range of one line has no start, and a range dragged upward starts at
 * its top, as the host and GitHub take them. */
export function placed(anchor: Anchor): Anchor {
  if (anchor.kind !== "line" || anchor.start?.side !== anchor.side)
    return anchor;
  const { line, start } = anchor;
  if (start.line === line) return { ...anchor, start: null };
  if (start.line > line)
    return { ...anchor, line: start.line, start: { ...start, line } };
  return anchor;
}

/** What a line annotation carries for a draft. The text is never in it, so
 * typing never redraws the diff. */
export type DraftKey = string & { readonly __brand: "DraftKey" };

/** One draft per key. A line number means something at one commit only, so a
 * line draft's key includes its head; every other draft follows the head. */
export function draftKey(given: Anchor, head: Oid): DraftKey {
  const anchor = placed(given);
  return JSON.stringify(
    anchor.kind === "line"
      ? [
          anchor.kind,
          head,
          anchor.path,
          anchor.side,
          anchor.line,
          anchor.start && [anchor.start.side, anchor.start.line],
        ]
      : anchor.kind === "reply"
        ? [anchor.kind, anchor.thread]
        : [anchor.kind],
  ) as DraftKey;
}
