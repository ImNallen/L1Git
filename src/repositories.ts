import { invoke, isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { z } from "zod";
import {
  detailSchema,
  repositoryErrorSchema,
  snapshotSchema,
} from "./domain/repository";
import type { FullRef, Oid } from "./domain/repository";

export const native = isTauri();
export const macNative = native && navigator.userAgent.includes("Mac");

async function read<T>(
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
      "The development reader is unavailable. Start pnpm dev and try again.",
    );
  }
  if (!response.ok)
    throw new Error(
      "The development reader rejected the request. Check that pnpm dev is running on this port.",
    );
  const envelope = z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), data: schema }),
    z.object({ ok: z.literal(false), error: repositoryErrorSchema }),
  ]);
  const parsed = envelope.parse(await response.json());
  if (!parsed.ok) throw parsed.error;
  return parsed.data;
}

export function snapshot(path: string, reference: FullRef | null = null) {
  return read(
    "repository_snapshot",
    "/api/snapshot",
    { path, reference },
    snapshotSchema,
  );
}

export function commitDetail(path: string, oid: Oid) {
  return read(
    "repository_commit_detail",
    "/api/commit-detail",
    { path, oid },
    detailSchema,
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
