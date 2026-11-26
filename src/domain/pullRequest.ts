import { z } from "zod";
import { githubRepositorySchema, oidSchema } from "./repository";

const page = <Item extends z.ZodType>(item: Item) =>
  z.object({ items: z.array(item), total: z.number().int().nonnegative() });
const time = z.iso.datetime();
const account = z.string().nullable();
const count = z.number().int().nonnegative();
const line = z.number().int().nullable();
/** GitHub's own id for a node, which a write names. */
const nodeId = <Brand extends string>() => z.string().min(1).brand<Brand>();

const stateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("open"), draft: z.boolean() }),
  z.object({ kind: z.literal("merged"), at: time }),
  z.object({ kind: z.literal("closed"), at: time }),
]);
const labelsSchema = page(z.object({ name: z.string(), color: z.string() }));
const mergeableSchema = z.enum(["mergeable", "conflicting", "unknown"]);
const checkStateSchema = z.enum(["passed", "failed", "skipped", "running"]);
const decisionSchema = z.enum(["approved", "changesRequested", "required"]);
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
    review: decisionSchema.nullable(),
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
/** `id` is GitHub's own, and stays the same from one read to the next. */
const entry = { id: z.string(), ...happened };
const eventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("commit"),
    oid: z.string(),
    headline: z.string(),
    ...entry,
  }),
  z.object({
    kind: z.literal("review"),
    state: reviewStateSchema,
    body: z.string(),
    ...entry,
  }),
  z.object({ kind: z.literal("comment"), body: z.string(), ...entry }),
  z.object({
    kind: z.literal("forcePushed"),
    from: z.string().nullable(),
    to: z.string().nullable(),
    ...entry,
  }),
  z.object({
    kind: z.literal("merged"),
    oid: z.string().nullable(),
    ...entry,
  }),
  z.object({ kind: z.literal("closed"), ...entry }),
  z.object({ kind: z.literal("reopened"), ...entry }),
  z.object({ kind: z.literal("branchDeleted"), ...entry }),
  z.object({ kind: z.literal("readyForReview"), ...entry }),
  z.object({ kind: z.literal("convertedToDraft"), ...entry }),
]);

export const pullRequestSchema = z.object({
  id: nodeId<"PullId">(),
  repositoryId: nodeId<"RepositoryId">(),
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string(),
  state: stateSchema,
  author: account,
  viewerIsAuthor: z.boolean(),
  /** The viewer's role in the base repository. */
  viewerPermission: z.enum([
    "admin",
    "maintain",
    "write",
    "triage",
    "read",
    "unknown",
  ]),
  base: z.string(),
  baseOid: oidSchema,
  labels: labelsSchema,
  additions: count,
  deletions: count,
  changedFiles: count,
  createdAt: time,
  updatedAt: time,
  head: z.object({
    branch: z.string(),
    oid: oidSchema,
    repository: githubRepositorySchema.nullable(),
    crossRepository: z.boolean(),
    maintainerCanModify: z.boolean(),
    /** Null once the branch is deleted. */
    ref: z
      .object({
        id: nodeId<"RefId">(),
        /** Other open pull requests whose head it is. Ones based on it are not counted. */
        othersOpen: count,
        viewerCanDelete: z.boolean(),
      })
      .nullable(),
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
      comments: page(z.object({ body: z.string(), ...entry })),
      can: z.object({
        reply: z.boolean(),
        resolve: z.boolean(),
        unresolve: z.boolean(),
      }),
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
  /** GitHub's own, which it makes only where a rule asks for reviews. */
  decision: decisionSchema.nullable(),
  merge: z.object({
    allowed: z.object({
      merge: z.boolean(),
      squash: z.boolean(),
      rebase: z.boolean(),
    }),
    /** The method GitHub preselects for the viewer. */
    preferred: z.enum(["merge", "squash", "rebase"]),
    /** GitHub deletes the head branch itself once it merges. */
    deletesBranch: z.boolean(),
  }),
  /** The viewer's review started on github.com and not submitted yet. */
  pending: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("none") }),
    /** GitHub left it out, so there may be one. */
    z.object({ kind: z.literal("unknown") }),
    z.object({
      kind: z.literal("review"),
      id: nodeId<"ReviewId">(),
      comments: page(z.object({ path: z.string() })),
    }),
  ]),
});

export type PullRequestList = "open" | "recentlyMerged";
export type PullRequests = z.infer<typeof pullRequestsSchema>;
export type PullRequestSummary = PullRequests["items"][number];
export type PullRequest = z.infer<typeof pullRequestSchema>;
export type TimelineEvent = PullRequest["timeline"]["items"][number];
export type ReviewThread = NonNullable<PullRequest["threads"]>["items"][number];
export type Check = NonNullable<PullRequest["checks"]>["items"][number];
export type ReviewState = PullRequest["reviewers"][number]["state"];
