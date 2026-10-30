import { useEffect, useState, useSyncExternalStore } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { z } from "zod";
import { freezeDrafts } from "./draftProtection";

const trackSchema = z.enum(["stable", "nightly"]);
const candidateSchema = z.object({
  id: z.string().regex(/^\d+$/).brand<"UpdateCandidateId">(),
  version: z.string().min(1),
  notes: z.string().nullable(),
});
const message = z.string().nullable();
const updateStateSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("unavailable"),
    reason: z.enum(["browser", "development", "manualLinux", "unsupported"]),
  }),
  z.object({ kind: z.literal("idle") }),
  z.object({ kind: z.literal("checking") }),
  z.object({ kind: z.literal("current") }),
  z.object({
    kind: z.literal("available"),
    candidate: candidateSchema,
    message,
  }),
  z.object({
    kind: z.literal("downloading"),
    candidate: candidateSchema,
    received: z.number().int().nonnegative(),
    total: z.number().int().positive().nullable(),
  }),
  z.object({
    kind: z.literal("downloaded"),
    candidate: candidateSchema,
    message,
  }),
  z.object({ kind: z.literal("installing"), candidate: candidateSchema }),
  z.object({ kind: z.literal("failed"), message: z.string() }),
]);
const snapshotSchema = z.object({
  revision: z.number().int().nonnegative(),
  installedVersion: z.string(),
  track: trackSchema,
  preferenceError: z.string().nullable(),
  state: updateStateSchema,
});
export type UpdateState = z.infer<typeof updateStateSchema>;
export type UpdateSnapshot = z.infer<typeof snapshotSchema>;
export type UpdateTrack = z.infer<typeof trackSchema>;
export type CandidateId = z.infer<typeof candidateSchema>["id"];
export const parseUpdateSnapshot = (value: unknown) =>
  snapshotSchema.parse(value);

type Command =
  | { name: "updater_snapshot" | "updater_check" }
  | { name: "updater_select_track"; args: { track: UpdateTrack } }
  | {
      name: "updater_download" | "updater_install";
      args: { candidate: CandidateId };
    };
export type UpdateTransport = {
  listen: (accept: (value: unknown) => void) => Promise<() => void>;
  invoke: (command: Command) => Promise<unknown>;
};

export function createUpdatesClient(transport: UpdateTransport | null) {
  let current: { snapshot: UpdateSnapshot; problem: string | null } = {
    snapshot: {
      revision: 0,
      installedVersion: transport ? "Loading…" : "Browser preview",
      track: "stable",
      preferenceError: null,
      state: transport
        ? { kind: "idle" }
        : { kind: "unavailable", reason: "browser" },
    },
    problem: null,
  };
  let revision = -1;
  let releaseDrafts: (() => void) | null = null;
  let installPending = false;
  function releaseFreeze() {
    releaseDrafts?.();
    releaseDrafts = null;
  }
  const listeners = new Set<() => void>();
  const publish = () => listeners.forEach((listener) => listener());
  function failed(error: unknown) {
    const parsed = z.string().safeParse(error);
    current = {
      ...current,
      problem: parsed.success
        ? parsed.data
        : "L1 Git could not read updater status. Try checking again.",
    };
    publish();
  }
  function accept(value: unknown) {
    try {
      const snapshot = parseUpdateSnapshot(value);
      if (snapshot.revision <= revision) return;
      revision = snapshot.revision;
      current = { snapshot, problem: null };
      if (snapshot.state.kind !== "installing" && !installPending)
        releaseFreeze();
      publish();
    } catch (error) {
      failed(error);
    }
  }
  async function run(command: Command) {
    if (!transport) return;
    try {
      accept(await transport.invoke(command));
    } catch (error) {
      failed(error);
    }
  }
  return {
    read: () => current,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async connect() {
      if (!transport) return () => {};
      try {
        const stop = await transport.listen(accept);
        await run({ name: "updater_snapshot" });
        return stop;
      } catch (error) {
        failed(error);
        return () => {};
      }
    },
    check: () => run({ name: "updater_check" }),
    selectTrack: (track: UpdateTrack) =>
      run({ name: "updater_select_track", args: { track } }),
    download: (candidate: CandidateId) =>
      run({ name: "updater_download", args: { candidate } }),
    async restart(candidate: CandidateId, consentRevision: number) {
      const freeze = freezeDrafts(consentRevision);
      if (freeze.kind !== "frozen") return freeze;
      releaseDrafts = freeze.release;
      installPending = true;
      try {
        await run({ name: "updater_install", args: { candidate } });
      } finally {
        installPending = false;
        if (current.snapshot.state.kind !== "installing") releaseFreeze();
      }
      return { kind: "accepted" } as const;
    },
  };
}

const nativeTransport: UpdateTransport = {
  listen: (accept) =>
    listen<unknown>("l1git-update", (event) => accept(event.payload)),
  invoke: (command) =>
    invoke<unknown>(command.name, "args" in command ? command.args : undefined),
};

export function useUpdates() {
  const [client] = useState(() =>
    createUpdatesClient(isTauri() ? nativeTransport : null),
  );
  const current = useSyncExternalStore(
    client.subscribe,
    client.read,
    client.read,
  );
  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | null = null;
    void client.connect().then((unsubscribe) => {
      if (disposed) unsubscribe();
      else stop = unsubscribe;
    });
    return () => {
      disposed = true;
      stop?.();
    };
  }, [client]);
  return { ...current, ...client };
}
export type Updates = ReturnType<typeof useUpdates>;
