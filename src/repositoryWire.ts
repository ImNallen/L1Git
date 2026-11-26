import type { MergeSelection } from "./domain/merge";
import {
  mergeReviewSchema,
  mergeStateSchema,
  mergeReportSchema,
  operationProbeSchema,
} from "./domain/merge";
import type { MergeAction } from "./domain/merge";
import { send } from "./transport";
import type { Route } from "./transport";
import { z } from "zod";
import {
  directoryListingSchema,
  newRepositorySchema,
} from "./domain/addRepository";
import {
  addRemoteReportSchema,
  publishOptionsSchema,
  pushAvailabilitySchema,
  pushReportSchema,
} from "./domain/push";
import type { AddRemoteInput, PublishChoice, PushIntent } from "./domain/push";
import { fastForwardReportSchema, overviewSchema } from "./domain/overview";
import { pullCheckoutSchema } from "./domain/pullRequestCheckout";
import type { PullHead, PullKey } from "./domain/pullRequestCheckout";
import type { Comparison } from "./domain/comparison";
import {
  commitsFetchSchema,
  rangeFilesSchema,
  rangePatchesSchema,
} from "./domain/range";
import type { Advance, FetchMode } from "./domain/overview";
import {
  appliedSchema,
  conflictFileSchema,
  conflictSummarySchema,
  wholeFileConflictSchema,
  blameSchema,
  branchMergedSchema,
  detailSchema,
  fileHistorySchema,
  filePatchSchema,
  lineStatsSchema,
  refsSchema,
  replayReviewSchema,
  repositoryErrorSchema,
  snapshotSchema,
  newWorktreeSchema,
  undoHistorySchema,
  worktreePatchSchema,
  worktreeReviewSchema,
  worktreeStatusSchema,
} from "./domain/repository";
import type {
  BranchTip,
  EntryId,
  Expect,
  GitHubRepository,
  Head,
  Oid,
  Operation,
  PatchContext,
  ReplayOf,
  RepositoryRoot,
  Side,
  WorktreeSource,
} from "./domain/repository";

type RepositoryRequest =
  | { op: "mergeReview"; path: RepositoryRoot; selection: MergeSelection }
  | { op: "mergeState"; path: RepositoryRoot }
  | { op: "operationProbe"; path: RepositoryRoot }
  | { op: "merge"; path: RepositoryRoot; action: MergeAction }
  | { op: "replayReview"; path: RepositoryRoot; of: ReplayOf }
  | { op: "replayAbort"; path: RepositoryRoot; of: ReplayOf; head: Head }
  | { op: "snapshot"; path: string }
  | { op: "refs"; path: RepositoryRoot }
  | { op: "commitDetail"; path: string; comparison: Comparison }
  | { op: "lineStats"; path: RepositoryRoot; oids: Oid[] }
  | {
      op: "filePatch";
      path: string;
      comparison: Comparison;
      file: string;
      from?: string;
      context?: PatchContext;
    }
  | { op: "rangeFiles"; path: RepositoryRoot; base: Oid; head: Oid }
  | { op: "rangePatches"; path: RepositoryRoot; mergeBase: Oid; head: Oid }
  | { op: "fileHistory"; path: RepositoryRoot; oid: Oid; file: string }
  | { op: "blame"; path: RepositoryRoot; oid: Oid; file: string }
  | { op: "overview"; path: RepositoryRoot; mode: FetchMode }
  | {
      op: "fetchCommits";
      path: RepositoryRoot;
      github: GitHubRepository;
      oids: [Oid] | [Oid, Oid];
    }
  | { op: "publishOptions"; path: RepositoryRoot }
  | { op: "addRemote"; path: RepositoryRoot; remote: AddRemoteInput }
  | { op: "preparePublish"; path: RepositoryRoot; choice: PublishChoice }
  | { op: "preparePush"; path: RepositoryRoot }
  | { op: "push"; path: RepositoryRoot; intent: PushIntent }
  | { op: "fastForward"; path: RepositoryRoot; advances: Advance[] }
  | { op: "conflictFile"; path: RepositoryRoot; file: string }
  | { op: "conflictSummary"; path: RepositoryRoot }
  | { op: "wholeFileConflict"; path: RepositoryRoot; file: string }
  | { op: "worktreeStatus"; path: RepositoryRoot }
  | {
      op: "worktreePatch";
      path: RepositoryRoot;
      file: string;
      side: Side;
      context?: PatchContext;
    }
  | { op: "write"; path: RepositoryRoot; operation: Operation; expect: Expect }
  | { op: "undo"; path: RepositoryRoot; id: EntryId }
  | { op: "redo"; path: RepositoryRoot; id: EntryId }
  | { op: "undoHistory"; path: RepositoryRoot }
  | { op: "branchMerged"; path: RepositoryRoot; branch: BranchTip }
  | { op: "listDirectories"; path: string }
  | { op: "createRepository"; path: string }
  | { op: "cloneRepository"; url: string; path: string }
  | { op: "cancelClone"; path: string }
  | { op: "worktreeReview"; path: RepositoryRoot; source: WorktreeSource }
  | {
      op: "createWorktree";
      path: RepositoryRoot;
      source: WorktreeSource;
      folder: string;
    }
  | { op: "removeWorktree"; path: RepositoryRoot; worktree: RepositoryRoot }
  | { op: "pullCheckout"; path: RepositoryRoot; pull: PullKey; head: PullHead }
  | {
      op: "tryPullRequest";
      path: RepositoryRoot;
      pull: PullKey;
      head: PullHead;
      folder: string;
    }
  | {
      op: "updatePullRequest";
      path: RepositoryRoot;
      pull: PullKey;
      head: PullHead;
      seen: Oid;
      replace: boolean;
    }
  | {
      op: "removePullRequest";
      path: RepositoryRoot;
      pull: PullKey;
      head: PullHead;
      seen: Oid;
    };

const responseSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("mergeReview"), data: mergeReviewSchema }),
  z.object({ op: z.literal("mergeState"), data: mergeStateSchema }),
  z.object({ op: z.literal("operationProbe"), data: operationProbeSchema }),
  z.object({ op: z.literal("merge"), data: mergeReportSchema }),
  z.object({ op: z.literal("replayReview"), data: replayReviewSchema }),
  z.object({ op: z.literal("replayAbort"), data: mergeStateSchema }),
  z.object({ op: z.literal("snapshot"), data: snapshotSchema }),
  z.object({ op: z.literal("refs"), data: refsSchema }),
  z.object({ op: z.literal("commitDetail"), data: detailSchema }),
  z.object({ op: z.literal("lineStats"), data: lineStatsSchema }),
  z.object({ op: z.literal("filePatch"), data: filePatchSchema }),
  z.object({ op: z.literal("rangeFiles"), data: rangeFilesSchema }),
  z.object({ op: z.literal("rangePatches"), data: rangePatchesSchema }),
  z.object({ op: z.literal("fileHistory"), data: fileHistorySchema }),
  z.object({ op: z.literal("blame"), data: blameSchema }),
  z.object({ op: z.literal("overview"), data: overviewSchema }),
  z.object({ op: z.literal("fetchCommits"), data: commitsFetchSchema }),
  z.object({ op: z.literal("publishOptions"), data: publishOptionsSchema }),
  z.object({ op: z.literal("addRemote"), data: addRemoteReportSchema }),
  z.object({ op: z.literal("preparePublish"), data: pushAvailabilitySchema }),
  z.object({ op: z.literal("preparePush"), data: pushAvailabilitySchema }),
  z.object({ op: z.literal("push"), data: pushReportSchema }),
  z.object({ op: z.literal("fastForward"), data: fastForwardReportSchema }),
  z.object({ op: z.literal("worktreeStatus"), data: worktreeStatusSchema }),
  z.object({ op: z.literal("conflictFile"), data: conflictFileSchema }),
  z.object({ op: z.literal("conflictSummary"), data: conflictSummarySchema }),
  z.object({
    op: z.literal("wholeFileConflict"),
    data: wholeFileConflictSchema,
  }),
  z.object({ op: z.literal("worktreePatch"), data: worktreePatchSchema }),
  z.object({ op: z.literal("write"), data: appliedSchema }),
  z.object({ op: z.literal("undo"), data: appliedSchema }),
  z.object({ op: z.literal("redo"), data: appliedSchema }),
  z.object({ op: z.literal("undoHistory"), data: undoHistorySchema }),
  z.object({ op: z.literal("branchMerged"), data: branchMergedSchema }),
  z.object({ op: z.literal("listDirectories"), data: directoryListingSchema }),
  z.object({ op: z.literal("createRepository"), data: newRepositorySchema }),
  z.object({ op: z.literal("cloneRepository"), data: newRepositorySchema }),
  z.object({ op: z.literal("cancelClone") }),
  z.object({ op: z.literal("worktreeReview"), data: worktreeReviewSchema }),
  z.object({ op: z.literal("createWorktree"), data: newWorktreeSchema }),
  z.object({ op: z.literal("removeWorktree") }),
  z.object({ op: z.literal("pullCheckout"), data: pullCheckoutSchema }),
  z.object({ op: z.literal("tryPullRequest"), data: pullCheckoutSchema }),
  z.object({ op: z.literal("updatePullRequest"), data: pullCheckoutSchema }),
  z.object({ op: z.literal("removePullRequest"), data: pullCheckoutSchema }),
]);
export const requestOps = responseSchema.options.map(
  (option) => option.shape.op.value,
);
type RepositoryResponse = z.infer<typeof responseSchema>;
type Answer<R extends RepositoryRequest> = Extract<
  RepositoryResponse,
  { op: R["op"] }
>;

const repositoryRoute: Route = {
  command: "repository_run",
  path: "/api/run",
  error: repositoryErrorSchema,
};

function answers<R extends RepositoryRequest>(
  request: R,
  response: RepositoryResponse,
): response is Answer<R> {
  return response.op === request.op;
}

export async function run<R extends RepositoryRequest>(
  request: R,
): Promise<Answer<R>> {
  const response = responseSchema.parse(await send(repositoryRoute, request));
  if (!answers(request, response))
    throw new Error(
      `L1 Git's core answered ${response.op} to a ${request.op} request.`,
    );
  return response;
}
