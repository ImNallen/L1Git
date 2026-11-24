import { z } from "zod";
import { githubRepositorySchema } from "./repository";

const page = <Item extends z.ZodType>(item: Item) =>
  z.object({ items: z.array(item), total: z.number().int().nonnegative() });
const time = z.iso.datetime();
const account = z.string().nullable();
const count = z.number().int().nonnegative();
const line = z.number().int().nullable();

const stateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("open"), draft: z.boolean() }),
  z.object({ kind: z.literal("merged"), at: time }),
  z.object({ kind: z.literal("closed"), at: time }),
]);
const labelsSchema = page(z.object({ name: z.string(), color: z.string() }));
const mergeableSchema = z.enum(["mergeable", "conflicting", "unknown"]);
const checkStateSchema = z.enum(["passed", "failed", "skipped", "running"]);
const reviewStateSchema = z.enum([
  "requested",
  "approved",
  "changesRequested",
  "dismissed",
  "commented",
]);

export const pullRequestsSchema = page(
  z.object({
    number: z.number().int().positive(),
    title: z.string(),
    state: stateSchema,
    author: account,
    viewerIsAuthor: z.boolean(),
    head: z.string(),
    base: z.string(),
    labels: labelsSchema,
    comments: count,
    reviewRequested: z.boolean(),
    review: z.enum(["approved", "changesRequested", "required"]).nullable(),
    checks: z
      .object({ passed: count, failed: count, skipped: count, running: count })
      .nullable(),
    mergeable: mergeableSchema,
    additions: count,
    deletions: count,
    createdAt: time,
    updatedAt: time,
  }),
);

const happened = { by: account, at: time };
const eventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("commit"),
    oid: z.string(),
    headline: z.string(),
    ...happened,
  }),
  z.object({
    kind: z.literal("review"),
    id: z.string(),
    state: reviewStateSchema,
    body: z.string(),
    ...happened,
  }),
  z.object({ kind: z.literal("comment"), body: z.string(), ...happened }),
  z.object({
    kind: z.literal("forcePushed"),
    from: z.string().nullable(),
    to: z.string().nullable(),
    ...happened,
  }),
  z.object({
    kind: z.literal("merged"),
    oid: z.string().nullable(),
    ...happened,
  }),
  z.object({ kind: z.literal("closed"), ...happened }),
  z.object({ kind: z.literal("reopened"), ...happened }),
  z.object({ kind: z.literal("branchDeleted"), ...happened }),
  z.object({ kind: z.literal("readyForReview"), ...happened }),
  z.object({ kind: z.literal("convertedToDraft"), ...happened }),
]);

export const pullRequestSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string(),
  state: stateSchema,
  author: account,
  viewerIsAuthor: z.boolean(),
  base: z.string(),
  labels: labelsSchema,
  additions: count,
  deletions: count,
  changedFiles: count,
  createdAt: time,
  updatedAt: time,
  head: z.object({
    branch: z.string(),
    oid: z.string(),
    repository: githubRepositorySchema.nullable(),
    crossRepository: z.boolean(),
    maintainerCanModify: z.boolean(),
  }),
  reviewers: z.array(z.object({ login: account, state: reviewStateSchema })),
  checks: page(
    z.object({
      name: z.string(),
      state: checkStateSchema,
      required: z.boolean(),
      startedAt: time.nullable(),
      completedAt: time.nullable(),
      url: z.string().nullable(),
    }),
  ).nullable(),
  commits: page(
    z.object({ oid: z.string(), headline: z.string(), ...happened }),
  ),
  timeline: page(eventSchema),
  /** Null when GitHub could only answer without them. */
  threads: page(
    z.object({
      id: z.string(),
      review: z.string().nullable(),
      path: z.string(),
      line,
      startLine: line,
      originalLine: line,
      originalStartLine: line,
      side: z.enum(["left", "right"]),
      outdated: z.boolean(),
      resolved: z.boolean(),
      hunk: z.string(),
      comments: page(z.object({ body: z.string(), ...happened })),
    }),
  ).nullable(),
  mergeable: mergeableSchema,
  mergeState: z.enum([
    "behind",
    "blocked",
    "clean",
    "dirty",
    "hasHooks",
    "unstable",
    "unknown",
  ]),
});

export type PullRequestList = "open" | "recentlyMerged";
export type PullRequests = z.infer<typeof pullRequestsSchema>;
export type PullRequestSummary = PullRequests["items"][number];
