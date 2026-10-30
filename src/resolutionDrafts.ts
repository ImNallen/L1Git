import { useSyncExternalStore } from "react";
import * as repositories from "./repositories";
import {
  beginDraftTask,
  draftImpact,
  publishResolutionImpact,
} from "./draftProtection";
import { conflictTextSchema, problemFrom } from "./domain/repository";
import type {
  ConflictFile,
  ConflictSnapshot,
  RepositoryRoot,
} from "./domain/repository";
import type { WritesView } from "./useWrites";

export type ResolutionDraft = {
  snapshot: ConflictSnapshot;
  text: string;
  revision: number;
  editorEpoch: number;
  observed: ConflictFile;
  phase:
    | { kind: "editing"; problem: string | null }
    | {
        kind: "saving" | "rereading";
        submittedRevision: number;
        submittedText: string;
      }
    | { kind: "marking" };
};
const drafts = new Map<string, ResolutionDraft>();
const reads = new Map<string, number>();
const pendingReads = new Map<string, number>();
const editors = new Map<string, symbol>();
const listeners = new Set<() => void>();
let epoch = 0;
export const resolutionKey = (root: RepositoryRoot, path: string) =>
  JSON.stringify([root, path]);
export const resolutionOf = (key: string) => drafts.get(key) ?? null;
export const isDirty = (draft: ResolutionDraft) =>
  draft.text !== draft.snapshot.working;
export const isStale = (draft: ResolutionDraft) =>
  draft.observed.kind !== "editable" ||
  draft.observed.snapshot.version !== draft.snapshot.version;
export const canMark = (draft: ResolutionDraft) =>
  draft.phase.kind === "editing" &&
  !pendingReads.has(resolutionKey(draft.snapshot.root, draft.snapshot.path)) &&
  !isDirty(draft) &&
  !isStale(draft) &&
  draft.phase.problem === null;
function publish(key: string, draft: ResolutionDraft | null) {
  if (draft) drafts.set(key, draft);
  else drafts.delete(key);
  publishResolutionImpact(
    [...drafts.values()]
      .filter(isDirty)
      .map(({ snapshot }) => ({ root: snapshot.root, path: snapshot.path })),
  );
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function useResolutionDraft(key: string) {
  return useSyncExternalStore(
    subscribe,
    () => resolutionOf(key),
    () => resolutionOf(key),
  );
}
function invalidateReads(key: string) {
  const next = (reads.get(key) ?? 0) + 1;
  reads.set(key, next);
  return next;
}
function fresh(snapshot: ConflictSnapshot): ResolutionDraft {
  return {
    snapshot,
    text: snapshot.working,
    revision: 0,
    editorEpoch: ++epoch,
    observed: { kind: "editable", snapshot },
    phase: { kind: "editing", problem: null },
  };
}
function observe(key: string, source: ConflictFile) {
  const draft = resolutionOf(key);
  if (draft?.phase.kind !== "editing" && draft !== null) return;
  if (source.kind === "external" && draft && !isDirty(draft)) {
    editors.delete(key);
    publish(key, null);
    return;
  }
  if (source.kind === "editable" && (!draft || !isDirty(draft))) {
    if (draft?.snapshot.version === source.snapshot.version)
      publish(key, {
        ...draft,
        observed: source,
        phase: { kind: "editing", problem: null },
      });
    else {
      editors.delete(key);
      publish(key, fresh(source.snapshot));
    }
  } else if (draft) publish(key, { ...draft, observed: source });
}

export async function readResolution(
  root: RepositoryRoot,
  path: string,
): Promise<ConflictFile | null> {
  const done = beginDraftTask();
  if (!done) return null;
  const key = resolutionKey(root, path);
  const token = invalidateReads(key);
  pendingReads.set(key, (pendingReads.get(key) ?? 0) + 1);
  const shown = resolutionOf(key);
  if (shown) publish(key, { ...shown });
  try {
    const source = await repositories.conflictFile(root, path);
    if (reads.get(key) === token) observe(key, source);
    return source;
  } catch (error) {
    const draft = resolutionOf(key);
    if (reads.get(key) === token && draft?.phase.kind === "editing")
      publish(key, {
        ...draft,
        phase: { kind: "editing", problem: problemFrom(error).message },
      });
    throw error;
  } finally {
    const remaining = (pendingReads.get(key) ?? 1) - 1;
    if (remaining === 0) pendingReads.delete(key);
    else pendingReads.set(key, remaining);
    const shown = resolutionOf(key);
    if (shown) publish(key, { ...shown });
    done();
  }
}

export function attachEditor(
  key: string,
  editorEpoch: number,
  session: symbol,
) {
  if (resolutionOf(key)?.editorEpoch === editorEpoch) editors.set(key, session);
}
export function editResolution(
  key: string,
  editorEpoch: number,
  session: symbol,
  text: string,
) {
  const draft = resolutionOf(key);
  if (
    !draft ||
    draft.editorEpoch !== editorEpoch ||
    editors.get(key) !== session ||
    draftImpact().frozen ||
    draft.phase.kind === "marking" ||
    draft.text === text
  )
    return;
  publish(key, { ...draft, text, revision: draft.revision + 1 });
}
export function completeEditor(
  key: string,
  editorEpoch: number,
  session: symbol,
  text: string,
) {
  editResolution(key, editorEpoch, session, text);
  if (editors.get(key) === session) editors.delete(key);
}
export function chooseResolution(
  key: string,
  editorEpoch: number,
  text: string,
) {
  const draft = resolutionOf(key);
  if (
    !draft ||
    draft.editorEpoch !== editorEpoch ||
    draftImpact().frozen ||
    draft.phase.kind !== "editing"
  )
    return;
  editors.delete(key);
  publish(key, {
    ...draft,
    text,
    revision: draft.revision + 1,
    editorEpoch: ++epoch,
  });
}

export async function reloadResolution(key: string, revision: number) {
  const draft = resolutionOf(key);
  if (!draft || draft.phase.kind !== "editing" || draftImpact().frozen) return;
  const done = beginDraftTask();
  if (!done) return;
  const token = invalidateReads(key);
  try {
    const source = await repositories.conflictFile(
      draft.snapshot.root,
      draft.snapshot.path,
    );
    const current = resolutionOf(key);
    if (
      reads.get(key) !== token ||
      !current ||
      current.revision !== revision ||
      current.editorEpoch !== draft.editorEpoch ||
      current.phase.kind !== "editing"
    )
      return;
    editors.delete(key);
    publish(key, source.kind === "editable" ? fresh(source.snapshot) : null);
  } catch (error) {
    const current = resolutionOf(key);
    if (current?.phase.kind === "editing")
      publish(key, {
        ...current,
        phase: { kind: "editing", problem: problemFrom(error).message },
      });
  } finally {
    done();
  }
}

export async function saveResolution(key: string, write: WritesView["write"]) {
  const sent = resolutionOf(key);
  if (
    !sent ||
    sent.phase.kind !== "editing" ||
    !isDirty(sent) ||
    isStale(sent) ||
    !conflictTextSchema.safeParse(sent.text).success
  )
    return;
  const done = beginDraftTask();
  if (!done) return;
  invalidateReads(key);
  const submitted = {
    submittedRevision: sent.revision,
    submittedText: sent.text,
  };
  publish(key, { ...sent, phase: { kind: "saving", ...submitted } });
  try {
    const outcome = await write(sent.snapshot.root, {
      expect: { head: sent.snapshot.head },
      operation: {
        kind: "saveConflict",
        path: sent.snapshot.path,
        version: sent.snapshot.version,
        text: sent.text,
      },
    });
    const current = resolutionOf(key);
    if (!current) return;
    publish(key, { ...current, phase: { kind: "rereading", ...submitted } });
    const source = await repositories.conflictFile(
      sent.snapshot.root,
      sent.snapshot.path,
    );
    const latest = resolutionOf(key);
    if (!latest) return;
    if (
      outcome.kind === "applied" &&
      source.kind === "editable" &&
      source.snapshot.working === sent.text &&
      source.snapshot.root === sent.snapshot.root &&
      source.snapshot.path === sent.snapshot.path &&
      JSON.stringify(source.snapshot.head) ===
        JSON.stringify(sent.snapshot.head) &&
      JSON.stringify(source.snapshot.entry) ===
        JSON.stringify(sent.snapshot.entry)
    ) {
      publish(key, {
        ...latest,
        snapshot: source.snapshot,
        observed: source,
        phase: { kind: "editing", problem: null },
      });
    } else {
      const problem =
        outcome.kind === "failed"
          ? outcome.problem.message
          : outcome.kind === "busy"
            ? "Another write is running. Your result is intact. Try Save result again."
            : "The file changed after Save. Your result is intact. Copy it or reload from disk.";
      publish(key, {
        ...latest,
        observed: source,
        phase: { kind: "editing", problem },
      });
    }
  } catch (error) {
    const current = resolutionOf(key);
    if (current)
      publish(key, {
        ...current,
        phase: { kind: "editing", problem: problemFrom(error).message },
      });
  } finally {
    invalidateReads(key);
    done();
  }
}

export async function markResolution(
  key: string,
  write: WritesView["write"],
): Promise<boolean> {
  const draft = resolutionOf(key);
  if (!draft || !canMark(draft)) return false;
  const done = beginDraftTask();
  if (!done) return false;
  invalidateReads(key);
  publish(key, { ...draft, phase: { kind: "marking" } });
  try {
    const source = await repositories.conflictFile(
      draft.snapshot.root,
      draft.snapshot.path,
    );
    if (
      source.kind !== "editable" ||
      source.snapshot.version !== draft.snapshot.version
    ) {
      publish(key, {
        ...draft,
        observed: source,
        phase: {
          kind: "editing",
          problem:
            "The conflict changed. Review the file before marking it resolved.",
        },
      });
      return false;
    }
    const outcome = await write(source.snapshot.root, {
      expect: { head: source.snapshot.head },
      operation: { kind: "stageFiles", entries: [source.snapshot.entry] },
    });
    if (outcome.kind === "applied") {
      editors.delete(key);
      publish(key, null);
      return true;
    }
    publish(key, {
      ...draft,
      phase: {
        kind: "editing",
        problem:
          outcome.kind === "failed"
            ? outcome.problem.message
            : "Another write is running. Try again.",
      },
    });
    return false;
  } catch (error) {
    publish(key, {
      ...draft,
      phase: { kind: "editing", problem: problemFrom(error).message },
    });
    return false;
  } finally {
    invalidateReads(key);
    done();
  }
}

export function resolutionConsent(
  root: RepositoryRoot,
  paths: readonly string[],
) {
  return [...drafts].filter(
    ([, draft]) =>
      draft.snapshot.root === root && paths.includes(draft.snapshot.path),
  );
}

export function discardConsentedResolutions(
  consent: ReturnType<typeof resolutionConsent>,
) {
  if (draftImpact().frozen) return;
  for (const [key, shown] of consent) {
    const current = resolutionOf(key);
    if (
      !current ||
      current.revision !== shown.revision ||
      current.editorEpoch !== shown.editorEpoch ||
      current.text !== shown.text
    )
      continue;
    invalidateReads(key);
    editors.delete(key);
    publish(key, null);
  }
}
