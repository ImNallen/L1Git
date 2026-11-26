import { z } from "zod";
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
});

export const pullDraftsSchema = z.object({
  drafts: z.array(draftSchema),
  refused: z
    .discriminatedUnion("kind", [
      /** Another window wrote since. */
      z.object({ kind: z.literal("stale") }),
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
});

export type Anchor = z.infer<typeof anchorSchema>;
export type Draft = z.infer<typeof draftSchema>;
export type PullDrafts = z.infer<typeof pullDraftsSchema>;

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
  | { kind: "delete"; anchor: Anchor; head: Oid; at: number };

/** What a line annotation carries for a draft. The text is never in it, so
 * typing never redraws the diff. */
export type DraftKey = string & { readonly __brand: "DraftKey" };

/** One draft per key. A line number means something at one commit only, so a
 * line draft's key includes its head; every other draft follows the head. */
export const draftKey = (anchor: Anchor, head: Oid): DraftKey =>
  JSON.stringify(
    anchor.kind === "line"
      ? [anchor.kind, head, anchor.path, anchor.side, anchor.line, anchor.start]
      : anchor.kind === "reply"
        ? [anchor.kind, anchor.thread]
        : [anchor.kind],
  ) as DraftKey;
