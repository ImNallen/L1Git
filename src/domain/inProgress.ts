import { composeMessage, splitMessage } from "./commitMessage";
import { conflictRegions, hasLeftoverMarkers } from "./conflictRegions";
import type { Draft } from "./commitMessage";
import { replayNames } from "./merge";
import { shortRef } from "./refs";
import type { MergeSession, MergeState, OperationProbe } from "./merge";
import type {
  ConflictSummary,
  Head,
  Oid,
  ReplayKind,
  RepositoryRoot,
  StatusEntry,
} from "./repository";
import { worktreeGroups } from "./worktree";
import type { WorktreeGroup } from "./worktree";

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

const headSide = (head: Head): OperationSide =>
  head.kind === "detached"
    ? { name: "Detached HEAD", oid: head.oid }
    : head.kind === "unborn"
      ? { name: shortRef(head.reference), oid: null }
      : { name: shortRef(head.reference), oid: head.oid };

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
          name: shortRef(review.destination.reference),
          oid: review.destination.oid,
        },
        incoming: {
          name: shortRef(review.source.reference),
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

type Running = Extract<InProgress, { kind: "running" }>;

export function progressLabel({ unresolved, total }: ConflictProgress) {
  if (total === null)
    return unresolved.length === 1
      ? "1 file left"
      : `${unresolved.length} files left`;
  if (total === 0) return "No conflicts";
  return `${total - unresolved.length} of ${total} resolved`;
}

export const operationWords: Record<
  OperationVerb,
  { noun: string; title: string; doing: string; onto: string }
> = {
  merge: { noun: "merge", title: "Merge", doing: "Merging", onto: "into" },
  cherryPick: {
    ...replayNames.cherryPick,
    doing: "Cherry-picking",
    onto: "onto",
  },
  revert: { ...replayNames.revert, doing: "Reverting", onto: "on" },
};

export function operationMessage(
  running: Pick<Running, "suggestedMessage">,
  draft: Draft,
): { draft: Draft; message: string; edited: boolean } {
  const edited = draft.summary !== "" || draft.description !== "";
  const shown = edited ? draft : splitMessage(running.suggestedMessage);
  return { draft: shown, message: composeMessage(shown), edited };
}

export type OperationGroup = WorktreeGroup & {
  kind: "unresolved" | "resolved" | "clean" | "staged" | "unstaged";
};

export function operationGroups(
  progress: ConflictProgress,
  entries: readonly StatusEntry[],
): OperationGroup[] {
  const lists = new Map(
    worktreeGroups(entries).map((group) => [group.side, group.files]),
  );
  const staged = new Map(
    (lists.get("staged") ?? []).map((file) => [file.path, file.status]),
  );
  const asStaged = (paths: readonly string[]) =>
    paths.map((path) => ({ path, status: staged.get(path) ?? "modified" }));
  const open = new Set(progress.unresolved);
  const groups: OperationGroup[] = [
    {
      kind: "unresolved",
      title: "Needs resolution",
      side: "conflict",
      files: progress.unresolved.map((path) => ({ path, status: "modified" })),
    },
    ...(progress.resolved === null || progress.clean === null
      ? [
          {
            kind: "staged" as const,
            title: "Staged",
            side: "staged" as const,
            files: (lists.get("staged") ?? []).filter(
              (file) => !open.has(file.path),
            ),
          },
        ]
      : [
          {
            kind: "resolved" as const,
            title: "Resolved",
            side: "staged" as const,
            files: asStaged(progress.resolved),
          },
          {
            kind: "clean" as const,
            title: "Merged cleanly",
            side: "staged" as const,
            files: asStaged(progress.clean),
          },
        ]),
    {
      kind: "unstaged",
      title: "Not staged",
      side: "unstaged",
      files: lists.get("unstaged") ?? [],
    },
  ];
  return groups.filter((group) => group.files.length > 0);
}

export const wholeFileLabels: Record<
  Extract<ConflictSummary, { kind: "wholeFile" }>["shape"],
  string
> = {
  deletedByThem: "Deleted vs edited",
  deletedByUs: "Deleted vs edited",
  binary: "Binary file",
  symlink: "Symlink",
  addedByUs: "Added on one side",
  addedByThem: "Added on one side",
};

export function draftConflictLabel(text: string): string {
  const regions = conflictRegions(text);
  if (regions > 0)
    return `${regions} ${regions === 1 ? "conflict" : "conflicts"} · unsaved`;
  return hasLeftoverMarkers(text)
    ? "Leftover markers · unsaved"
    : "Unsaved result";
}

export function conflictLabel(summary: ConflictSummary): string {
  switch (summary.kind) {
    case "text":
      return summary.conflicts === 0
        ? "Ready to mark resolved"
        : summary.conflicts === 1
          ? "1 conflict"
          : `${summary.conflicts} conflicts`;
    case "wholeFile":
      return wholeFileLabels[summary.shape];
    case "external":
      return "Resolve outside L1 Git";
  }
}

type ExternalOperation = Extract<
  OperationProbe,
  { kind: "external" }
>["operations"][number];

export function probeOf(
  state: MergeState,
  known: OperationProbe | undefined,
): OperationProbe {
  switch (state.kind) {
    case "idle":
      return { kind: "idle" };
    case "active":
      return { kind: "merge", attention: false };
    case "replay":
      return { kind: "replay", replay: state.progress.kind };
    case "attention":
      if (state.session !== null || state.reason === "recoveryRequired")
        return { kind: "merge", attention: true };
      return known?.kind === "external"
        ? known
        : { kind: "external", operations: [] };
  }
}

const externalWords: Record<
  ExternalOperation,
  { doing: string; noun: string }
> = {
  merge: { doing: "Merging", noun: "a merge" },
  cherryPick: { doing: "Cherry-picking", noun: "a cherry-pick" },
  revert: { doing: "Reverting", noun: "a revert" },
  rebase: { doing: "Rebasing", noun: "a rebase" },
  rebaseOrAm: { doing: "In progress", noun: "a rebase or am" },
  sequence: {
    doing: "In progress",
    noun: "a cherry-pick or revert of several commits",
  },
  bisect: { doing: "Bisecting", noun: "a bisect" },
};

const openToFinish = "Open the repository to finish or abort it.";

export function operationBadge(
  probe: OperationProbe,
): { label: string; title: string } | null {
  switch (probe.kind) {
    case "idle":
      return null;
    case "merge":
      return probe.attention
        ? {
            label: "Needs attention",
            title:
              "A merge stopped partway and needs attention. Open the repository to see how to continue.",
          }
        : {
            label: operationWords.merge.doing,
            title: `A merge is in progress. ${openToFinish}`,
          };
    case "replay": {
      const { doing, noun } = operationWords[probe.replay];
      return {
        label: doing,
        title: `A ${noun} is in progress. ${openToFinish}`,
      };
    }
    case "external": {
      const [first] = probe.operations;
      const { doing, noun } =
        first === undefined
          ? { doing: "In progress", noun: "a Git operation" }
          : externalWords[first];
      return {
        label: doing,
        title: `${noun.replace(/^a/, "A")} started outside L1 Git is in progress. Continue or abort it in your terminal.`,
      };
    }
  }
}
