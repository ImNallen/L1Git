import type { MergeSelection } from "./domain/merge";
import {
  mergeReviewSchema,
  mergeStateSchema,
  mergeActionSchema,
  mergeReportSchema,
} from "./domain/merge";
import type { MergeAction } from "./domain/merge";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { z } from "zod";
import {
  addRemoteInputSchema,
  addRemoteReportSchema,
  publishOptionsSchema,
  pushAvailabilitySchema,
  pushReportSchema,
} from "./domain/push";
import type { AddRemoteInput, PublishChoice, PushIntent } from "./domain/push";
import { fastForwardReportSchema, overviewSchema } from "./domain/overview";
import type { Comparison } from "./domain/comparison";
import type { Advance, FetchMode } from "./domain/overview";
import {
  appliedSchema,
  conflictFileSchema,
  operationSchema,
  blameSchema,
  branchMergedSchema,
  detailSchema,
  fileHistorySchema,
  filePatchSchema,
  lineStatsSchema,
  refsSchema,
  repositoryErrorSchema,
  snapshotSchema,
  undoHistorySchema,
  worktreePatchSchema,
  worktreeStatusSchema,
} from "./domain/repository";
import type {
  BranchTip,
  EntryId,
  Expect,
  Oid,
  Operation,
  RepositoryRoot,
  Side,
} from "./domain/repository";

export const native = isTauri();
export const mac = navigator.userAgent.includes("Mac");
export const macNative = native && mac;

type RepositoryRequest =
  | { op: "mergeReview"; path: RepositoryRoot; selection: MergeSelection }
  | { op: "mergeState"; path: RepositoryRoot }
  | { op: "merge"; path: RepositoryRoot; action: MergeAction }
  | { op: "snapshot"; path: string }
  | { op: "refs"; path: RepositoryRoot }
  | { op: "commitDetail"; path: string; comparison: Comparison }
  | { op: "lineStats"; path: RepositoryRoot; oids: Oid[] }
  | { op: "filePatch"; path: string; comparison: Comparison; file: string }
  | { op: "fileHistory"; path: RepositoryRoot; oid: Oid; file: string }
  | { op: "blame"; path: RepositoryRoot; oid: Oid; file: string }
  | { op: "overview"; path: RepositoryRoot; mode: FetchMode }
  | { op: "publishOptions"; path: RepositoryRoot }
  | { op: "addRemote"; path: RepositoryRoot; remote: AddRemoteInput }
  | { op: "preparePublish"; path: RepositoryRoot; choice: PublishChoice }
  | { op: "preparePush"; path: RepositoryRoot }
  | { op: "push"; path: RepositoryRoot; intent: PushIntent }
  | { op: "fastForward"; path: RepositoryRoot; advances: Advance[] }
  | { op: "conflictFile"; path: RepositoryRoot; file: string }
  | { op: "worktreeStatus"; path: RepositoryRoot }
  | { op: "worktreePatch"; path: RepositoryRoot; file: string; side: Side }
  | { op: "write"; path: RepositoryRoot; operation: Operation; expect: Expect }
  | { op: "undo"; path: RepositoryRoot; id: EntryId }
  | { op: "redo"; path: RepositoryRoot; id: EntryId }
  | { op: "undoHistory"; path: RepositoryRoot }
  | { op: "branchMerged"; path: RepositoryRoot; branch: BranchTip };

const responseSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("mergeReview"), data: mergeReviewSchema }),
  z.object({ op: z.literal("mergeState"), data: mergeStateSchema }),
  z.object({ op: z.literal("merge"), data: mergeReportSchema }),
  z.object({ op: z.literal("snapshot"), data: snapshotSchema }),
  z.object({ op: z.literal("refs"), data: refsSchema }),
  z.object({ op: z.literal("commitDetail"), data: detailSchema }),
  z.object({ op: z.literal("lineStats"), data: lineStatsSchema }),
  z.object({ op: z.literal("filePatch"), data: filePatchSchema }),
  z.object({ op: z.literal("fileHistory"), data: fileHistorySchema }),
  z.object({ op: z.literal("blame"), data: blameSchema }),
  z.object({ op: z.literal("overview"), data: overviewSchema }),
  z.object({ op: z.literal("publishOptions"), data: publishOptionsSchema }),
  z.object({ op: z.literal("addRemote"), data: addRemoteReportSchema }),
  z.object({ op: z.literal("preparePublish"), data: pushAvailabilitySchema }),
  z.object({ op: z.literal("preparePush"), data: pushAvailabilitySchema }),
  z.object({ op: z.literal("push"), data: pushReportSchema }),
  z.object({ op: z.literal("fastForward"), data: fastForwardReportSchema }),
  z.object({ op: z.literal("worktreeStatus"), data: worktreeStatusSchema }),
  z.object({ op: z.literal("conflictFile"), data: conflictFileSchema }),
  z.object({ op: z.literal("worktreePatch"), data: worktreePatchSchema }),
  z.object({ op: z.literal("write"), data: appliedSchema }),
  z.object({ op: z.literal("undo"), data: appliedSchema }),
  z.object({ op: z.literal("redo"), data: appliedSchema }),
  z.object({ op: z.literal("undoHistory"), data: undoHistorySchema }),
  z.object({ op: z.literal("branchMerged"), data: branchMergedSchema }),
]);
export const requestOps = responseSchema.options.map(
  (option) => option.shape.op.value,
);
const envelopeSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: repositoryErrorSchema }),
]);
const rejectionSchema = z.object({ error: z.string() });

type RepositoryResponse = z.infer<typeof responseSchema>;
type Answer<R extends RepositoryRequest> = Extract<
  RepositoryResponse,
  { op: R["op"] }
>;

async function send(request: RepositoryRequest): Promise<unknown> {
  const serialized = JSON.stringify(request);
  if (new TextEncoder().encode(serialized).length > 4 * 1024 * 1024)
    throw new Error("This request exceeds the 4 MiB transport limit.");
  if (native) return invoke<unknown>("repository_run", { request });
  let response: Response;
  try {
    response = await fetch("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: serialized,
    });
  } catch {
    throw new Error(
      "The development bridge is unavailable. Start pnpm dev and try again.",
    );
  }
  if (response.status === 400) {
    const rejection = rejectionSchema.safeParse(
      await response.json().catch(() => null),
    );
    if (rejection.success)
      throw new Error(
        `The development bridge rejected the request. ${rejection.data.error}`,
      );
  }
  if (!response.ok)
    throw new Error(
      "The development bridge rejected the request. Check that pnpm dev is running on this port.",
    );
  const body: unknown = await response.json();
  const envelope = envelopeSchema.parse(body);
  if (!envelope.ok) throw envelope.error;
  return body;
}

function answers<R extends RepositoryRequest>(
  request: R,
  response: RepositoryResponse,
): response is Answer<R> {
  return response.op === request.op;
}

async function run<R extends RepositoryRequest>(
  request: R,
): Promise<Answer<R>> {
  const response = responseSchema.parse(await send(request));
  if (!answers(request, response))
    throw new Error(
      `L1 Git's core answered ${response.op} to a ${request.op} request.`,
    );
  return response;
}

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

export async function filePatch(
  path: string,
  comparison: Comparison,
  file: string,
) {
  return (await run({ op: "filePatch", path, comparison, file })).data;
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

export async function worktreeStatus(path: RepositoryRoot) {
  return (await run({ op: "worktreeStatus", path })).data;
}

export async function worktreePatch(
  path: RepositoryRoot,
  file: string,
  side: Side,
) {
  return (await run({ op: "worktreePatch", path, file, side })).data;
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

export async function chooseDirectory(): Promise<string | null> {
  if (!native) return null;
  const result = await open({
    title: "Add a Git repository",
    directory: true,
    multiple: false,
  });
  return typeof result === "string" ? result : null;
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
export async function merge(path: RepositoryRoot, action: MergeAction) {
  return (
    await run({ op: "merge", path, action: mergeActionSchema.parse(action) })
  ).data;
}
