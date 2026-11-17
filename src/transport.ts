import { invoke, isTauri } from "@tauri-apps/api/core";
import { z } from "zod";

export const native = isTauri();

export type Route = {
  command: string;
  path: string;
  error: z.ZodType;
};

const rejectionSchema = z.object({ error: z.string() });

export async function send(route: Route, request: unknown): Promise<unknown> {
  const serialized = JSON.stringify(request);
  if (new TextEncoder().encode(serialized).length > 4 * 1024 * 1024)
    throw new Error("This request exceeds the 4 MiB transport limit.");
  if (native) return invoke<unknown>(route.command, { request });
  let response: Response;
  try {
    response = await fetch(route.path, {
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
  const envelope = z
    .discriminatedUnion("ok", [
      z.object({ ok: z.literal(true) }),
      z.object({ ok: z.literal(false), error: route.error }),
    ])
    .parse(body);
  if (!envelope.ok) throw envelope.error;
  return body;
}
