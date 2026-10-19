import { invoke, isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { z } from "zod";
import { fastForwardReportSchema, overviewSchema } from "./domain/overview";
import type { Advance, FetchMode } from "./domain/overview";
import {
  detailSchema,
  filePatchSchema,
  refsSchema,
  repositoryErrorSchema,
  snapshotSchema,
} from "./domain/repository";
import type { Oid, RepositoryRoot } from "./domain/repository";

export const native = isTauri();
export const macNative = native && navigator.userAgent.includes("Mac");

async function call<T>(
  command: string,
  endpoint: string,
  args: Record<string, unknown>,
  schema: z.ZodType<T>,
): Promise<T> {
  if (native) return schema.parse(await invoke<unknown>(command, args));
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
  } catch {
    throw new Error(
      "The development bridge is unavailable. Start pnpm dev and try again.",
    );
  }
  if (!response.ok)
    throw new Error(
      "The development bridge rejected the request. Check that pnpm dev is running on this port.",
    );
  const envelope = z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), data: schema }),
    z.object({ ok: z.literal(false), error: repositoryErrorSchema }),
  ]);
  const parsed = envelope.parse(await response.json());
  if (!parsed.ok) throw parsed.error;
  return parsed.data;
}

export function snapshot(path: string) {
  return call("repository_snapshot", "/api/snapshot", { path }, snapshotSchema);
}

export function refs(path: RepositoryRoot) {
  return call("repository_refs", "/api/refs", { path }, refsSchema);
}

export function commitDetail(path: string, oid: Oid) {
  return call(
    "repository_commit_detail",
    "/api/commit-detail",
    { path, oid },
    detailSchema,
  );
}

export function filePatch(path: string, oid: Oid, file: string) {
  return call(
    "repository_file_patch",
    "/api/file-patch",
    { path, oid, file },
    filePatchSchema,
  );
}

export function overview(path: RepositoryRoot, mode: FetchMode) {
  return call(
    "repository_overview",
    "/api/overview",
    { path, mode },
    overviewSchema,
  );
}

export function fastForward(path: RepositoryRoot, advances: Advance[]) {
  return call(
    "repository_fast_forward",
    "/api/fast-forward",
    { path, advances },
    fastForwardReportSchema,
  );
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
