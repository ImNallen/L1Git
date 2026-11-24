import { z } from "zod";

const page = <Item extends z.ZodType>(item: Item) =>
  z.object({ items: z.array(item), total: z.number().int().nonnegative() });
const time = z.iso.datetime();
const account = z.string().nullable();
const count = z.number().int().nonnegative();

export const pullRequestsSchema = page(
  z.object({
    number: z.number().int().positive(),
    title: z.string(),
    state: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("open"), draft: z.boolean() }),
      z.object({ kind: z.literal("merged"), at: time }),
      z.object({ kind: z.literal("closed"), at: time }),
    ]),
    author: account,
    viewerIsAuthor: z.boolean(),
    head: z.string(),
    base: z.string(),
    labels: page(z.object({ name: z.string(), color: z.string() })),
    comments: count,
    reviewRequested: z.boolean(),
    review: z.enum(["approved", "changesRequested", "required"]).nullable(),
    checks: z
      .object({ passed: count, failed: count, skipped: count, running: count })
      .nullable(),
    mergeable: z.enum(["mergeable", "conflicting", "unknown"]),
    additions: count,
    deletions: count,
    updatedAt: time,
  }),
);

export type PullRequestList = "open" | "recentlyMerged";
