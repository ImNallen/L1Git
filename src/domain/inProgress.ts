import type { MergeSession, MergeState } from "./merge";
import type { Head, Oid, ReplayKind, RepositoryRoot } from "./repository";

export type OperationVerb = "merge" | ReplayKind;

export type OperationSide = { name: string; oid: Oid | null };

export type ConflictProgress = {
  unresolved: readonly string[];
  resolved: readonly string[] | null;
  clean: readonly string[] | null;
  total: number | null;
};

export type InProgress =
  | { kind: "none" }
  | {
      kind: "running";
      root: RepositoryRoot;
      verb: OperationVerb;
      key: string;
      current: OperationSide;
      incoming: OperationSide;
      subject: string | null;
      progress: ConflictProgress;
      phase: "conflicted" | "ready" | "empty";
      sourceMoved: boolean;
      footprint: readonly string[];
      staged: string;
      tree: Oid | null;
      suggestedMessage: string;
    }
  | {
      kind: "attention";
      message: string;
      session: MergeSession | null;
    }
  | { kind: "external"; message: string };

const localName = (reference: string) =>
  reference.replace(/^refs\/(?:heads|remotes)\//, "");

const headSide = (head: Head): OperationSide =>
  head.kind === "detached"
    ? { name: "Detached HEAD", oid: head.oid }
    : head.kind === "unborn"
      ? { name: localName(head.reference), oid: null }
      : { name: localName(head.reference), oid: head.oid };

function progressOf(
  footprint: readonly string[],
  conflicted: readonly string[] | null,
  unresolved: readonly string[],
): ConflictProgress {
  if (conflicted === null)
    return { unresolved, resolved: null, clean: null, total: null };
  const open = new Set(unresolved);
  const stopped = new Set(conflicted);
  return {
    unresolved,
    resolved: conflicted.filter((path) => !open.has(path)),
    clean: footprint.filter((path) => !stopped.has(path)),
    total: conflicted.length,
  };
}

export function inProgress(state: MergeState | null): InProgress {
  if (state === null) return { kind: "none" };
  switch (state.kind) {
    case "idle":
      return { kind: "none" };
    case "attention":
      return state.reason === "externalOperation"
        ? { kind: "external", message: state.message }
        : { kind: "attention", message: state.message, session: state.session };
    case "active": {
      const { session } = state;
      const { review } = session;
      return {
        kind: "running",
        root: review.root,
        verb: "merge",
        key: session.id,
        current: {
          name: localName(review.destination.reference),
          oid: review.destination.oid,
        },
        incoming: {
          name: localName(review.source.reference),
          oid: review.source.oid,
        },
        subject: null,
        progress: progressOf(
          session.footprint,
          session.conflicted,
          state.unresolved,
        ),
        phase: state.unresolved.length > 0 ? "conflicted" : "ready",
        sourceMoved: state.sourceMoved,
        footprint: session.footprint,
        staged: state.staged,
        tree: state.tree,
        suggestedMessage: session.suggestedMessage,
      };
    }
    case "replay": {
      const { progress } = state;
      return {
        kind: "running",
        root: progress.root,
        verb: progress.kind,
        key: `${progress.kind}:${progress.commit}`,
        current: headSide(progress.destination),
        incoming: { name: progress.commit.slice(0, 7), oid: progress.commit },
        subject: progress.subject,
        progress: progressOf(
          progress.footprint,
          progress.conflicted,
          progress.unresolved,
        ),
        phase: progress.empty
          ? "empty"
          : progress.unresolved.length > 0
            ? "conflicted"
            : "ready",
        sourceMoved: false,
        footprint: progress.footprint,
        staged: progress.staged,
        tree: progress.tree,
        suggestedMessage: progress.suggestedMessage,
      };
    }
  }
}

export type FinishBlock =
  | "unresolved"
  | "unsavedResults"
  | "notStaged"
  | "amending"
  | "noMessage";

export function finishBlock(
  running: Extract<InProgress, { kind: "running" }>,
  {
    unsavedResults,
    amending,
    message,
  }: { unsavedResults: boolean; amending: boolean; message: string },
): FinishBlock | null {
  if (running.progress.unresolved.length > 0) return "unresolved";
  if (unsavedResults) return "unsavedResults";
  if (running.tree === null) return "notStaged";
  if (amending && running.verb !== "merge") return "amending";
  if (message.trim() === "") return "noMessage";
  return null;
}
