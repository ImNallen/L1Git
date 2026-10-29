import { expect, it, vi } from "vitest";
import { createUpdatesClient, parseUpdateSnapshot } from "./updates";
import type { UpdateTransport } from "./updates";
import {
  beginDraftTask,
  clearSubmitted,
  draftImpact,
  draftOf,
  setDraft,
} from "./commitDrafts";
import { rootSchema } from "./domain/repository";

const snapshot = (revision: number, state: unknown, track = "stable") => ({
  revision,
  installedVersion: "0.1.0",
  preferenceError: null,
  track,
  state,
});
const candidate = { id: "1", version: "0.2.0", notes: null };
const ready = parseUpdateSnapshot(
  snapshot(1, { kind: "downloaded", candidate, message: null }),
);
if (ready.state.kind !== "downloaded") throw new Error("Fixture invalid");
const id = ready.state.candidate.id;

function client() {
  let receive: (value: unknown) => void = () => {};
  const transport = {
    listen: vi.fn(async (accept: (value: unknown) => void) => {
      receive = accept;
      return vi.fn();
    }),
    invoke: vi
      .fn<UpdateTransport["invoke"]>()
      .mockResolvedValue(snapshot(0, { kind: "idle" })),
  };
  return {
    updates: createUpdatesClient(transport),
    transport,
    emit: (value: unknown) => receive(value),
  };
}

it("subscribes before snapshot and ignores stale and duplicate command/event revisions", async () => {
  const { updates, transport, emit } = client();
  transport.invoke.mockImplementation(async () => {
    expect(transport.listen).toHaveBeenCalledOnce();
    emit(
      snapshot(3, { kind: "available", candidate, message: null }, "nightly"),
    );
    return snapshot(1, { kind: "idle" });
  });
  await updates.connect();
  expect(updates.read().snapshot.track).toBe("nightly");
  emit(snapshot(3, { kind: "current" }));
  emit(snapshot(2, { kind: "current" }));
  expect(updates.read().snapshot.state.kind).toBe("available");
  emit(snapshot(4, { kind: "current" }, "stable"));
  expect(updates.read().snapshot.track).toBe("stable");
});

it("parses IPC and reports invalid payloads without replacing valid state", async () => {
  const { updates, emit } = client();
  await updates.connect();
  emit(
    snapshot(1, {
      kind: "downloaded",
      candidate: { id: "url", version: "", notes: null },
    }),
  );
  expect(updates.read().snapshot.state.kind).toBe("idle");
  expect(updates.read().problem).toContain("could not read");
  expect(() =>
    parseUpdateSnapshot(
      snapshot(2, { kind: "unavailable", reason: "anything" }),
    ),
  ).toThrow();
});

it("has an explicit browser/manual-update state and invokes nothing", async () => {
  const updates = createUpdatesClient(null);
  await updates.connect();
  await updates.check();
  expect(updates.read().snapshot.state).toEqual({
    kind: "unavailable",
    reason: "browser",
  });
});

it("keeps all drafts on busy/failure and holds freeze across accepted install until native failure", async () => {
  const { updates, transport, emit } = client();
  const root = rootSchema.parse("/fixture/hidden-root");
  setDraft(root, {
    draft: { summary: "Never discard before restart", description: "" },
    amend: null,
  });
  const original = draftOf(root);
  await updates.connect();
  emit(ready);
  const finish = beginDraftTask();
  expect(await updates.restart(id, draftImpact().revision)).toEqual({
    kind: "busy",
  });
  expect(transport.invoke).toHaveBeenCalledTimes(1);
  finish?.();
  const revision = draftImpact().revision;
  setDraft(root, { ...original });
  expect(await updates.restart(id, revision)).toEqual({ kind: "changed" });
  transport.invoke.mockResolvedValue(
    snapshot(2, {
      kind: "downloaded",
      candidate,
      message: "Repository work is still running.",
    }),
  );
  await updates.restart(id, draftImpact().revision);
  expect(draftImpact().frozen).toBe(false);
  expect(draftOf(root)).toEqual(original);
  transport.invoke.mockRejectedValue("IPC disconnected");
  await updates.restart(id, draftImpact().revision);
  expect(draftImpact().frozen).toBe(false);
  transport.invoke.mockResolvedValue(
    snapshot(3, { kind: "installing", candidate }),
  );
  await updates.restart(id, draftImpact().revision);
  expect(draftImpact().frozen).toBe(true);
  expect(beginDraftTask()).toBeNull();
  emit(
    snapshot(4, {
      kind: "downloaded",
      candidate,
      message: "Cannot replace app",
    }),
  );
  expect(draftImpact().frozen).toBe(false);
  expect(draftOf(root)).toEqual(original);
  clearSubmitted(root, draftOf(root));
});

it("sends only track or candidate identity, and never starts a download during checks", async () => {
  const { updates, transport } = client();
  await updates.connect();
  await updates.check();
  await updates.selectTrack("nightly");
  await updates.download(id);
  expect(transport.invoke.mock.calls.map(([command]) => command)).toEqual([
    { name: "updater_snapshot" },
    { name: "updater_check" },
    { name: "updater_select_track", args: { track: "nightly" } },
    { name: "updater_download", args: { candidate: id } },
  ]);
});

it("releases the freeze when native install failure arrives before its older installing response", async () => {
  const { updates, transport, emit } = client();
  await updates.connect();
  emit(ready);
  transport.invoke.mockImplementation(async () => {
    expect(draftImpact().frozen).toBe(true);
    emit(
      snapshot(3, { kind: "downloaded", candidate, message: "Install failed" }),
    );
    return snapshot(2, { kind: "installing", candidate });
  });
  await updates.restart(id, draftImpact().revision);
  expect(updates.read().snapshot.state.kind).toBe("downloaded");
  expect(draftImpact().frozen).toBe(false);
});
