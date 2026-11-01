import { z } from "zod";
import {
  branchTipSchema,
  entryIdSchema,
  oidSchema,
  refSchema,
  rootSchema,
  stagedStampSchema,
} from "./repository";
import type { Operation } from "./repository";

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
export const mergeSessionSchema = z.strictObject({
  id: entryIdSchema,
  review: mergeReviewSchema,
  footprint: z.array(z.string()),
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
export const mergeOutcomeSchema = z.discriminatedUnion("kind", [
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

export function mergeAllows(
  state: MergeState | null,
  operation: Operation,
): boolean {
  if (!state || state.kind === "idle") return true;
  const owned = (path: string) =>
    state.kind === "active"
      ? state.session.footprint.includes(path)
      : state.reason === "externalOperation";
  switch (operation.kind) {
    case "saveConflict":
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
      return false;
  }
}
