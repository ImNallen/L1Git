import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as repositories from "./repositories";
import { appliedSchema, conflictSnapshotSchema } from "./domain/repository";
import { draftImpact, freezeDrafts } from "./draftProtection";
import { clearSubmitted, draftOf, setDraft } from "./commitDrafts";
import {
  attachEditor,
  canMark,
  chooseResolution,
  completeEditor,
  editResolution,
  isDirty,
  isStale,
  markResolution,
  readResolution,
  reloadResolution,
  resolutionKey,
  resolutionOf,
  saveResolution,
} from "./resolutionDrafts";
import type { Outcome, WritesView } from "./useWrites";

vi.mock("./repositories", () => ({ conflictFile: vi.fn() }));
const snapshot = conflictSnapshotSchema.parse({
  root: "/work/conflict",
  path: "f.txt",
  head: { kind: "detached", oid: "a".repeat(40) },
  entry: {
    kind: "unmerged",
    path: "f.txt",
    conflict: "bothModified",
    submodule: null,
    stages: Object.fromEntries(
      ["base", "ours", "theirs"].map((key) => [
        key,
        { mode: "100644", oid: "a".repeat(40) },
      ]),
    ),
  },
  version: "b".repeat(40),
  base: "base\n",
  current: "ours\n",
  incoming: "theirs\n",
  working: "markers\n",
});
const key = resolutionKey(snapshot.root, snapshot.path);
const write = vi.fn<WritesView["write"]>();
function draft() {
  const value = resolutionOf(key);
  if (!value) throw new Error("Missing draft");
  return value;
}
function editor() {
  const session = Symbol();
  const epoch = draft().editorEpoch;
  attachEditor(key, epoch, session);
  return {
    session,
    epoch,
    edit: (text: string) => editResolution(key, epoch, session, text),
  };
}
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { resolve, promise };
}
const applied = appliedSchema.parse({
  id: "a".repeat(16),
  root: snapshot.root,
  operation: {
    kind: "saveConflict",
    path: snapshot.path,
    version: snapshot.version,
  },
});
beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(repositories.conflictFile).mockResolvedValue({
    kind: "editable",
    snapshot,
  });
  await readResolution(snapshot.root, snapshot.path);
});
afterEach(async () => {
  vi.mocked(repositories.conflictFile).mockResolvedValue({
    kind: "external",
    root: snapshot.root,
    path: snapshot.path,
    reason: "structural",
  });
  if (resolutionOf(key)) await reloadResolution(key, draft().revision);
  clearSubmitted(snapshot.root, draftOf(snapshot.root));
  expect(draftImpact().tasks).toBe(0);
  expect(draftImpact().resolutions).toEqual([]);
});

it("keeps dirty text and its baseline through navigation, refresh, disappearing conflicts and late reads", async () => {
  const active = editor();
  active.edit("my result\n");
  const late =
    deferred<Awaited<ReturnType<typeof repositories.conflictFile>>>();
  vi.mocked(repositories.conflictFile).mockReturnValueOnce(late.promise);
  const reading = readResolution(snapshot.root, snapshot.path);
  active.edit("newer result\n");
  vi.mocked(repositories.conflictFile).mockResolvedValueOnce({
    kind: "external",
    root: snapshot.root,
    path: snapshot.path,
    reason: "structural",
  });
  await readResolution(snapshot.root, snapshot.path);
  late.resolve({ kind: "editable", snapshot });
  await reading;
  expect(draft().text).toBe("newer result\n");
  expect(draft().snapshot).toEqual(snapshot);
  expect(isStale(draft())).toBe(true);
  expect(canMark(draft())).toBe(false);
  expect(draftImpact().resolutions).toEqual([
    { root: snapshot.root, path: snapshot.path },
  ]);
});

it("fences late completion after choices and after another editor attaches", () => {
  const old = editor();
  old.edit("typed\n");
  chooseResolution(key, old.epoch, "chosen\n");
  completeEditor(key, old.epoch, old.session, "old late text\n");
  expect(draft().text).toBe("chosen\n");
  const first = editor();
  const second = editor();
  second.edit("new session\n");
  completeEditor(key, first.epoch, first.session, "late session\n");
  expect(draft().text).toBe("new session\n");
});

it("advances only submitted save text while newer typing remains dirty", async () => {
  const active = editor();
  active.edit("submitted\n");
  const pending = deferred<Outcome>();
  write.mockReturnValueOnce(pending.promise);
  const saving = saveResolution(key, write);
  expect(draft().phase.kind).toBe("saving");
  expect(canMark(draft())).toBe(false);
  active.edit("typed while saving\n");
  vi.mocked(repositories.conflictFile).mockResolvedValueOnce({
    kind: "editable",
    snapshot: {
      ...snapshot,
      version: conflictSnapshotSchema.parse({
        ...snapshot,
        version: "c".repeat(40),
      }).version,
      working: "submitted\n",
    },
  });
  pending.resolve({ kind: "applied", applied });
  await saving;
  expect(draft().snapshot.working).toBe("submitted\n");
  expect(draft().text).toBe("typed while saving\n");
  expect(isDirty(draft())).toBe(true);
  expect(isStale(draft())).toBe(false);
});

it.each(["head", "stages"])(
  "keeps newer edits tied to their original conflict when %s changes after Save",
  async (changed) => {
    const active = editor();
    active.edit("submitted\n");
    const pending = deferred<Outcome>();
    write.mockReturnValueOnce(pending.promise);
    const saving = saveResolution(key, write);
    active.edit("newer old-context result\n");
    const fresh = conflictSnapshotSchema.parse({
      ...snapshot,
      version: "e".repeat(40),
      working: "submitted\n",
      ...(changed === "head"
        ? { head: { kind: "detached", oid: "f".repeat(40) } }
        : {
            entry: {
              ...snapshot.entry,
              stages: {
                ...snapshot.entry.stages,
                ours: { mode: "100644", oid: "f".repeat(40) },
              },
            },
          }),
    });
    vi.mocked(repositories.conflictFile).mockResolvedValueOnce({
      kind: "editable",
      snapshot: fresh,
    });
    pending.resolve({ kind: "applied", applied });
    await saving;
    expect(draft().text).toBe("newer old-context result\n");
    expect(draft().snapshot).toEqual(snapshot);
    expect(isStale(draft())).toBe(true);
    expect(canMark(draft())).toBe(false);
  },
);

it.each(["failed", "busy", "throw"])(
  "preserves text after a %s save",
  async (outcome) => {
    editor().edit("precious result\n");
    if (outcome === "throw")
      write.mockRejectedValueOnce(new Error("lost transport"));
    else
      write.mockResolvedValueOnce(
        outcome === "busy"
          ? { kind: "busy" }
          : {
              kind: "failed",
              problem: { kind: "gitFailed", message: "write failed" },
            },
      );
    await saveResolution(key, write);
    expect(draft().text).toBe("precious result\n");
    expect(isDirty(draft())).toBe(true);
    expect(draft().phase.kind).toBe("editing");
    expect(canMark(draft())).toBe(false);
  },
);

it("requires fresh state for separate Mark resolved and never marks a dirty result", async () => {
  editor().edit("dirty\n");
  await markResolution(key, write);
  expect(write).not.toHaveBeenCalled();
  await reloadResolution(key, draft().revision);
  vi.mocked(repositories.conflictFile).mockResolvedValueOnce({
    kind: "external",
    root: snapshot.root,
    path: snapshot.path,
    reason: "structural",
  });
  await markResolution(key, write);
  expect(write).not.toHaveBeenCalled();
  await reloadResolution(key, draft().revision);
  write.mockResolvedValueOnce({ kind: "applied", applied });
  expect(await markResolution(key, write)).toBe(true);
  expect(write.mock.calls[0]?.[1].operation).toEqual({
    kind: "stageFiles",
    entries: [snapshot.entry],
  });
  expect(resolutionOf(key)).toBeNull();
});

it("shares revision, tasks and freeze with commit drafts and protects newer text from discard consent", async () => {
  const active = editor();
  active.edit("result\n");
  setDraft(snapshot.root, {
    draft: { summary: "commit", description: "" },
    amend: null,
  });
  const consent = draftImpact().revision;
  active.edit("newer\n");
  expect(freezeDrafts(consent)).toEqual({ kind: "changed" });
  const late =
    deferred<Awaited<ReturnType<typeof repositories.conflictFile>>>();
  vi.mocked(repositories.conflictFile).mockReturnValueOnce(late.promise);
  const discard = reloadResolution(key, draft().revision);
  expect(freezeDrafts(draftImpact().revision)).toEqual({ kind: "busy" });
  active.edit("after discard request\n");
  late.resolve({ kind: "editable", snapshot });
  await discard;
  expect(draft().text).toBe("after discard request\n");
  const frozen = freezeDrafts(draftImpact().revision);
  if (frozen.kind !== "frozen") throw new Error("Not frozen");
  active.edit("blocked");
  expect(draft().text).toBe("after discard request\n");
  await saveResolution(key, write);
  expect(write).not.toHaveBeenCalled();
  frozen.release();
});
