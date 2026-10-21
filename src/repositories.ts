import { invoke, isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { z } from "zod";
import { fastForwardReportSchema, overviewSchema } from "./domain/overview";
import type { Advance, FetchMode } from "./domain/overview";
import {
  detailSchema,
  filePatchSchema,
  lineStatsSchema,
  refsSchema,
  repositoryErrorSchema,
  snapshotSchema,
} from "./domain/repository";
import type { Oid, RepositoryRoot } from "./domain/repository";

export const native = isTauri();
export const macNative = native && navigator.userAgent.includes("Mac");

type RepositoryRequest =
  | { op: "snapshot"; path: string }
  | { op: "refs"; path: RepositoryRoot }
  | { op: "commitDetail"; path: string; oid: Oid }
  | { op: "lineStats"; path: RepositoryRoot; oids: Oid[] }
  | { op: "filePatch"; path: string; oid: Oid; file: string }
  | { op: "overview"; path: RepositoryRoot; mode: FetchMode }
  | { op: "fastForward"; path: RepositoryRoot; advances: Advance[] };

const responseSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("snapshot"), data: snapshotSchema }),
  z.object({ op: z.literal("refs"), data: refsSchema }),
  z.object({ op: z.literal("commitDetail"), data: detailSchema }),
  z.object({ op: z.literal("lineStats"), data: lineStatsSchema }),
  z.object({ op: z.literal("filePatch"), data: filePatchSchema }),
  z.object({ op: z.literal("overview"), data: overviewSchema }),
  z.object({ op: z.literal("fastForward"), data: fastForwardReportSchema }),
]);
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
  if (native) return invoke<unknown>("repository_run", { request });
  let response: Response;
  try {
    response = await fetch("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
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

export async function commitDetail(path: string, oid: Oid) {
  return (await run({ op: "commitDetail", path, oid })).data;
}

export async function lineStats(path: RepositoryRoot, oids: Oid[]) {
  return (await run({ op: "lineStats", path, oids })).data;
}

export async function filePatch(path: string, oid: Oid, file: string) {
  return (await run({ op: "filePatch", path, oid, file })).data;
}

export async function overview(path: RepositoryRoot, mode: FetchMode) {
  return (await run({ op: "overview", path, mode })).data;
}

export async function fastForward(path: RepositoryRoot, advances: Advance[]) {
  return (await run({ op: "fastForward", path, advances })).data;
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
