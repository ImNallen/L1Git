import type { MergeAction, MergeSelection } from "./domain/merge";
import { mergeActionSchema } from "./domain/merge";
import { native } from "./transport";
import { addRemoteInputSchema } from "./domain/push";
import type { AddRemoteInput, PublishChoice, PushIntent } from "./domain/push";
import { pullKeySchema } from "./domain/pullRequestCheckout";
import type { PullHead, PullKey } from "./domain/pullRequestCheckout";
import type { Comparison } from "./domain/comparison";
import type { Advance, FetchMode } from "./domain/overview";
import { operationSchema, worktreeSourceSchema } from "./domain/repository";
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
import { run } from "./repositoryWire";

export const mac = navigator.userAgent.includes("Mac");
export const macNative = native && mac;

export async function snapshot(path: string) {
  return (await run({ op: "snapshot", path })).data;
}

export async function refs(path: RepositoryRoot) {
  return (await run({ op: "refs", path })).data;
}

export async function commitDetail(path: string, comparison: Comparison) {
  return (await run({ op: "commitDetail", path, comparison })).data;
}

export async function lineStats(path: RepositoryRoot, oids: Oid[]) {
  return (await run({ op: "lineStats", path, oids })).data;
}

/** `from` is the file's path at the base, which is `file` unless it was renamed. With it the file reads as `rangePatches` reads it. */
export async function filePatch(
  path: string,
  comparison: Comparison,
  file: string,
  context?: PatchContext,
  from?: string,
) {
  return (await run({ op: "filePatch", path, comparison, file, from, context }))
    .data;
}

export async function rangeFiles(path: RepositoryRoot, base: Oid, head: Oid) {
  return (await run({ op: "rangeFiles", path, base, head })).data;
}

export async function rangePatches(
  path: RepositoryRoot,
  mergeBase: Oid,
  head: Oid,
) {
  return (await run({ op: "rangePatches", path, mergeBase, head })).data;
}

export async function fetchCommits(
  path: RepositoryRoot,
  github: GitHubRepository,
  oids: [Oid] | [Oid, Oid],
) {
  return (await run({ op: "fetchCommits", path, github, oids })).data;
}

export async function fileHistory(
  path: RepositoryRoot,
  oid: Oid,
  file: string,
) {
  return (await run({ op: "fileHistory", path, oid, file })).data;
}

export async function blame(path: RepositoryRoot, oid: Oid, file: string) {
  return (await run({ op: "blame", path, oid, file })).data;
}

export async function overview(path: RepositoryRoot, mode: FetchMode) {
  return (await run({ op: "overview", path, mode })).data;
}

export async function fastForward(path: RepositoryRoot, advances: Advance[]) {
  return (await run({ op: "fastForward", path, advances })).data;
}

export async function conflictFile(path: RepositoryRoot, file: string) {
  return (await run({ op: "conflictFile", path, file })).data;
}

export async function conflictSummary(path: RepositoryRoot) {
  return (await run({ op: "conflictSummary", path })).data;
}

export async function wholeFileConflict(path: RepositoryRoot, file: string) {
  return (await run({ op: "wholeFileConflict", path, file })).data;
}

export async function worktreeStatus(path: RepositoryRoot) {
  return (await run({ op: "worktreeStatus", path })).data;
}

export async function worktreePatch(
  path: RepositoryRoot,
  file: string,
  side: Side,
  context?: PatchContext,
) {
  return (await run({ op: "worktreePatch", path, file, side, context })).data;
}

export async function write(
  path: RepositoryRoot,
  operation: Operation,
  expect: Expect,
) {
  return (
    await run({
      op: "write",
      path,
      operation: operationSchema.parse(operation),
      expect,
    })
  ).data;
}

export async function undo(path: RepositoryRoot, id: EntryId) {
  return (await run({ op: "undo", path, id })).data;
}

export async function redo(path: RepositoryRoot, id: EntryId) {
  return (await run({ op: "redo", path, id })).data;
}

export async function undoHistory(path: RepositoryRoot) {
  return (await run({ op: "undoHistory", path })).data;
}

export async function branchMerged(path: RepositoryRoot, branch: BranchTip) {
  return (await run({ op: "branchMerged", path, branch })).data;
}

export async function listDirectories(path: string) {
  return (await run({ op: "listDirectories", path })).data;
}

/** The home folder that `~` names in a typed path, or null when the core
 * cannot find one. */
export async function home() {
  return (await run({ op: "home" })).data;
}

export async function createRepository(path: string) {
  return (await run({ op: "createRepository", path })).data;
}

/** An abort asks the core to stop the clone and remove what it copied. */
export async function cloneRepository(
  url: string,
  path: string,
  signal: AbortSignal,
) {
  const cancel = () => {
    run({ op: "cancelClone", path }).catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    return (await run({ op: "cloneRepository", url, path })).data;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

export async function worktreeReview(
  path: RepositoryRoot,
  source: WorktreeSource,
) {
  return (
    await run({
      op: "worktreeReview",
      path,
      source: worktreeSourceSchema.parse(source),
    })
  ).data;
}

/** `folder` as typed. The core expands `~`. */
export async function createWorktree(
  path: RepositoryRoot,
  source: WorktreeSource,
  folder: string,
) {
  return (
    await run({
      op: "createWorktree",
      path,
      source: worktreeSourceSchema.parse(source),
      folder,
    })
  ).data;
}

export async function removeWorktree(
  path: RepositoryRoot,
  worktree: RepositoryRoot,
) {
  await run({ op: "removeWorktree", path, worktree });
}

export async function pullCheckout(
  path: RepositoryRoot,
  pull: PullKey,
  head: PullHead,
) {
  return (
    await run({
      op: "pullCheckout",
      path,
      pull: pullKeySchema.parse(pull),
      head,
    })
  ).data;
}

/** `folder` as typed. The core expands `~`. */
export async function tryPullRequest(
  path: RepositoryRoot,
  pull: PullKey,
  head: PullHead,
  folder: string,
) {
  return (
    await run({
      op: "tryPullRequest",
      path,
      pull: pullKeySchema.parse(pull),
      head,
      folder,
    })
  ).data;
}

/** `seen` is the tip of `pr/<number>` the user saw. Without `replace`, only a branch behind the head moves. */
export async function updatePullRequest(
  path: RepositoryRoot,
  pull: PullKey,
  head: PullHead,
  seen: Oid,
  replace: boolean,
) {
  return (
    await run({
      op: "updatePullRequest",
      path,
      pull: pullKeySchema.parse(pull),
      head,
      seen,
      replace,
    })
  ).data;
}

export async function removePullRequest(
  path: RepositoryRoot,
  pull: PullKey,
  head: PullHead,
  seen: Oid,
) {
  return (
    await run({
      op: "removePullRequest",
      path,
      pull: pullKeySchema.parse(pull),
      head,
      seen,
    })
  ).data;
}

export async function preparePush(path: RepositoryRoot) {
  return (await run({ op: "preparePush", path })).data;
}

export async function push(path: RepositoryRoot, intent: PushIntent) {
  return (await run({ op: "push", path, intent })).data;
}

export async function publishOptions(path: RepositoryRoot) {
  return (await run({ op: "publishOptions", path })).data;
}
export async function addRemote(path: RepositoryRoot, remote: AddRemoteInput) {
  return (
    await run({
      op: "addRemote",
      path,
      remote: addRemoteInputSchema.parse(remote),
    })
  ).data;
}
export async function preparePublish(
  path: RepositoryRoot,
  choice: PublishChoice,
) {
  return (await run({ op: "preparePublish", path, choice })).data;
}

export async function mergeReview(
  path: RepositoryRoot,
  selection: MergeSelection,
) {
  return (await run({ op: "mergeReview", path, selection })).data;
}
export async function mergeState(path: RepositoryRoot) {
  return (await run({ op: "mergeState", path })).data;
}
export async function operationProbe(path: RepositoryRoot) {
  return (await run({ op: "operationProbe", path })).data;
}
export async function merge(path: RepositoryRoot, action: MergeAction) {
  return (
    await run({ op: "merge", path, action: mergeActionSchema.parse(action) })
  ).data;
}
export async function replayReview(path: RepositoryRoot, of: ReplayOf) {
  return (await run({ op: "replayReview", path, of })).data;
}

export async function replayAbort(
  path: RepositoryRoot,
  of: ReplayOf,
  head: Head,
) {
  return (await run({ op: "replayAbort", path, of, head })).data;
}
