import { z } from "zod";
import {
  branchTipSchema,
  entryIdSchema,
  headSchema,
  oidSchema,
  refSchema,
  replayKindSchema,
  rootSchema,
  stagedStampSchema,
} from "./repository";
import type { Operation, ReplayKind } from "./repository";

export const mergeSelectionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("upstream") }),
  z.strictObject({ kind: z.literal("branch"), reference: refSchema }),
]);
const mergeTrackingSchema = z.strictObject({
  remote: z.string(),
  merge: z.string(),
  fetch: z.array(z.string()),
});
export const mergeReviewSchema = z.strictObject({
  root: rootSchema,
  destination: branchTipSchema,
  source: z.strictObject({ reference: refSchema, oid: oidSchema }),
  context: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("branch") }),
    z.strictObject({
      kind: z.literal("upstream"),
      tracking: mergeTrackingSchema,
    }),
  ]),
  plan: z.enum(["upToDate", "fastForward", "mergeCommit"]),
});
const mergeSessionSchema = z.strictObject({
  id: entryIdSchema,
  review: mergeReviewSchema,
  footprint: z.array(z.string()),
  conflicted: z.array(z.string()).nullable(),
  suggestedMessage: z.string(),
});
const replayProgressSchema = z.strictObject({
  root: rootSchema,
  kind: replayKindSchema,
  commit: oidSchema,
  subject: z.string(),
  destination: headSchema,
  footprint: z.array(z.string()),
  conflicted: z.array(z.string()),
  unresolved: z.array(z.string()),
  staged: stagedStampSchema,
  tree: oidSchema.nullable(),
  empty: z.boolean(),
  suggestedMessage: z.string(),
});
export const mergeStateSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("idle") }),
  z.strictObject({
    kind: z.literal("active"),
    session: mergeSessionSchema,
    unresolved: z.array(z.string()),
    staged: stagedStampSchema,
    tree: oidSchema.nullable(),
    sourceMoved: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("attention"),
    session: mergeSessionSchema.nullable(),
    reason: z.enum(["externalOperation", "recoveryRequired"]),
    message: z.string(),
  }),
  z.strictObject({ kind: z.literal("replay"), progress: replayProgressSchema }),
]);
export const operationProbeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("idle") }),
  z.strictObject({ kind: z.literal("merge"), attention: z.boolean() }),
  z.strictObject({ kind: z.literal("replay"), replay: replayKindSchema }),
  z.strictObject({
    kind: z.literal("external"),
    operations: z.array(
      z.enum([
        "merge",
        "cherryPick",
        "revert",
        "rebase",
        "rebaseOrAm",
        "sequence",
        "bisect",
      ]),
    ),
  }),
]);
export const mergeActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("start"), review: mergeReviewSchema }),
  z.strictObject({
    kind: z.literal("finish"),
    session: entryIdSchema,
    staged: stagedStampSchema,
    tree: oidSchema,
    message: z.string(),
  }),
  z.strictObject({ kind: z.literal("abort"), session: entryIdSchema }),
]);
const mergeOutcomeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("upToDate") }),
  z.strictObject({
    kind: z.literal("fastForwarded"),
    commit: oidSchema,
    problem: z.string().nullable(),
  }),
  z.strictObject({
    kind: z.literal("started"),
    problem: z.string().nullable(),
  }),
  z.strictObject({
    kind: z.literal("finished"),
    commit: oidSchema,
    problem: z.string().nullable(),
  }),
  z.strictObject({ kind: z.literal("aborted") }),
  z.strictObject({ kind: z.literal("notStarted"), problem: z.string() }),
]);
export const mergeReportSchema = z.strictObject({
  state: mergeStateSchema,
  outcome: mergeOutcomeSchema,
});
export type MergeSelection = z.infer<typeof mergeSelectionSchema>;
export type MergeReview = z.infer<typeof mergeReviewSchema>;
export type MergeState = z.infer<typeof mergeStateSchema>;
export type MergeAction = z.infer<typeof mergeActionSchema>;
export type MergeReport = z.infer<typeof mergeReportSchema>;
export type MergeSession = z.infer<typeof mergeSessionSchema>;
export type ReplayProgress = z.infer<typeof replayProgressSchema>;
export type OperationProbe = z.infer<typeof operationProbeSchema>;

export const replayNames: Record<ReplayKind, { noun: string; title: string }> =
  {
    cherryPick: { noun: "cherry-pick", title: "Cherry-pick" },
    revert: { noun: "revert", title: "Revert" },
  };

/** The menu and palette entry. `branch` is null when the active worktree is on no branch. */
export const replayEntry = (kind: ReplayKind, branch: string | null) =>
  kind === "cherryPick"
    ? `Cherry-pick onto ${branch ?? "current branch"}…`
    : branch === null
      ? "Revert…"
      : `Revert on ${branch}…`;

export function mergeAllows(
  state: MergeState | null,
  operation: Operation,
): boolean {
  if (!state || state.kind === "idle") return true;
  const owned = (path: string) =>
    state.kind === "active"
      ? state.session.footprint.includes(path)
      : state.kind === "replay"
        ? state.progress.footprint.includes(path)
        : state.reason === "externalOperation";
  switch (operation.kind) {
    case "saveConflict":
    case "resolveWhole":
    case "stageHunk":
    case "unstageHunk":
    case "stageLines":
    case "unstageLines":
      return owned(operation.path);
    case "stageFiles":
    case "unstageFiles":
      return operation.entries.every(
        (entry) =>
          owned(entry.path) &&
          (entry.kind !== "renamed" || owned(entry.original)),
      );
    case "commit":
    case "amend":
    case "editMessage":
    case "discard":
    case "discardHunk":
    case "discardLines":
    case "createBranch":
    case "renameBranch":
    case "deleteBranch":
    case "checkout":
    case "createTag":
    case "deleteTag":
    case "stashPush":
    case "stashApply":
    case "stashPop":
    case "stashDrop":
    case "replay":
    case "rebase":
      return false;
    case "finishReplay":
      return state.kind === "replay";
  }
}
