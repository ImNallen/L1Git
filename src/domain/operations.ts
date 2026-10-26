import { subjectOf } from "./commitMessage";
import { shownText, splittable } from "./lineSelection";
import type { ListSide } from "./worktree";
import type {
  Applied,
  Branch,
  BranchMerged,
  BranchTip,
  EntryId,
  Expect,
  Head,
  LinePick,
  Operation,
  Problem,
  Start,
  StatusEntry,
  WorktreePatch,
  WorktreeStatus,
} from "./repository";

type FileOperation = Extract<Operation, { entries: unknown }>;
type BranchOperation = Extract<
  Operation,
  { kind: "createBranch" | "renameBranch" | "deleteBranch" }
>;
type CommitOperation = Extract<Operation, { message: unknown }>;
type PartOperation = Extract<Operation, { shown: unknown }>;
export type FileWrite = FileOperation["kind"];
export type CommitWrite = CommitOperation["kind"];
export type PartWrite = PartOperation["kind"];

export type Write = { operation: Operation; expect: Expect };

export function writeFor(
  kind: FileWrite,
  status: WorktreeStatus,
  paths: readonly string[],
): Write | null {
  const wanted = new Set(paths);
  const entries = status.entries.filter((entry) => wanted.has(entry.path));
  if (entries.length === 0) return null;
  return { operation: { kind, entries }, expect: { head: status.head } };
}

export function commitWrite(
  kind: CommitWrite,
  status: WorktreeStatus,
  message: string,
): Write {
  const operation: Operation =
    kind === "editMessage"
      ? { kind, message }
      : { kind, message, staged: status.stagedStamp };
  return { operation, expect: { head: status.head } };
}

export type PartAction = "stage" | "unstage" | "discard";
export type PartChoice =
  | { kind: "hunk"; hunk: number }
  | { kind: "lines"; lines: LinePick[] };

const hunkWrites = {
  stage: "stageHunk",
  unstage: "unstageHunk",
  discard: "discardHunk",
} as const satisfies Record<PartAction, PartWrite>;
const lineWrites = {
  stage: "stageLines",
  unstage: "unstageLines",
  discard: "discardLines",
} as const satisfies Record<PartAction, PartWrite>;

const decodedWithReplacements = (path: string) => path.includes("\uFFFD");

export function partActions(
  patch: WorktreePatch,
  entry: StatusEntry | undefined,
  side: ListSide,
): readonly PartAction[] {
  const shown = shownText(patch);
  if (
    shown === null ||
    !splittable(shown) ||
    entry === undefined ||
    side === "conflict" ||
    decodedWithReplacements(entry.path)
  )
    return [];
  switch (entry.kind) {
    case "unmerged":
      return [];
    case "untracked":
      return ["stage", "discard"];
    case "renamed":
      if (entry.submodule !== null || entry.side.kind === "unstaged") return [];
      return side === "staged" ? ["unstage"] : ["stage", "discard"];
    case "ordinary": {
      if (entry.submodule !== null) return [];
      if (side === "staged") return ["unstage"];
      const addedWithIntent = entry.index === null;
      return addedWithIntent ? ["stage"] : ["stage", "discard"];
    }
  }
}

export function partWrite(
  action: PartAction,
  status: WorktreeStatus,
  path: string,
  shown: string,
  choice: PartChoice,
): Write {
  const operation: Operation =
    choice.kind === "hunk"
      ? { kind: hunkWrites[action], path, hunk: choice.hunk, shown }
      : { kind: lineWrites[action], path, lines: choice.lines, shown };
  return { operation, expect: { head: status.head } };
}

export const movesRefs = (operation: Operation) =>
  "message" in operation || isBranchOperation(operation);

export type BranchAsk =
  | { kind: "create"; at: Start; from: string }
  | { kind: "rename"; branch: BranchTip; name: string }
  | { kind: "delete"; branch: BranchTip; name: string };

export function branchAsks(branch: Branch): {
  create: BranchAsk;
  rename: BranchAsk | null;
  delete: BranchAsk | null;
} {
  const { reference, oid, name } = branch;
  if (branch.kind === "remote")
    return {
      create: {
        kind: "create",
        at: { kind: "remote", reference, oid },
        from: name,
      },
      rename: null,
      delete: null,
    };
  const tip = { reference, oid };
  return {
    create: {
      kind: "create",
      at: { kind: "local", reference, oid },
      from: name,
    },
    rename: { kind: "rename", branch: tip, name },
    delete: { kind: "delete", branch: tip, name },
  };
}

export const isBranchOperation = (
  operation: Operation,
): operation is BranchOperation =>
  operation.kind === "createBranch" ||
  operation.kind === "renameBranch" ||
  operation.kind === "deleteBranch";

export const branchWrite = (operation: BranchOperation, head: Head): Write => ({
  operation,
  expect: { head },
});

const branchName = (branch: BranchTip) =>
  branch.reference.replace(/^refs\/heads\//, "");

export function notMergedInto(
  name: string,
  merged: BranchMerged,
  head: string,
): string | null {
  const missing = [
    ...(merged.head ? [] : [head]),
    ...(merged.upstream && !merged.upstream.merged
      ? [
          `its upstream ${merged.upstream.reference.replace(/^refs\/remotes\//, "")}`,
        ]
      : []),
  ];
  if (missing.length === 0) return null;
  return `${name} is not merged into ${missing.join(" or ")}.`;
}

export function discardable(entry: StatusEntry): boolean {
  switch (entry.kind) {
    case "ordinary": {
      const addedWithIntent = entry.index === null;
      return (
        entry.submodule === null &&
        !addedWithIntent &&
        entry.sides.kind !== "staged"
      );
    }
    case "renamed":
      return (
        entry.submodule === null &&
        entry.side.kind === "staged" &&
        entry.side.unstaged !== null
      );
    case "untracked": {
      const nestedRepository = entry.path.endsWith("/");
      return !nestedRepository;
    }
    case "unmerged":
      return false;
  }
}

export const discardablePaths = (status: WorktreeStatus): ReadonlySet<string> =>
  new Set(status.entries.filter(discardable).map((entry) => entry.path));

export function discardChoice(
  status: WorktreeStatus,
  paths: readonly string[],
): { paths: string[]; skipped: number } {
  const able = discardablePaths(status);
  const kept = paths.filter((path) => able.has(path));
  return { paths: kept, skipped: paths.length - kept.length };
}

const SHOWN_PATHS = 10;

export function shownPaths(paths: readonly string[]): {
  shown: readonly string[];
  more: number;
} {
  return {
    shown: paths.slice(0, SHOWN_PATHS),
    more: Math.max(0, paths.length - SHOWN_PATHS),
  };
}

const SUBJECT_LIMIT = 60;

function quoted(message: string): string {
  const subject = subjectOf(message);
  return `“${subject.length > SUBJECT_LIMIT ? `${subject.slice(0, SUBJECT_LIMIT - 1)}…` : subject}”`;
}

const commitVerbs: Record<CommitWrite, string> = {
  commit: "Commit",
  amend: "Amend",
  editMessage: "Edit message to",
};

const fileVerbs: Record<FileWrite, string> = {
  stageFiles: "Stage",
  unstageFiles: "Unstage",
  discard: "Discard",
};

const partVerbs: Record<PartWrite, string> = {
  stageHunk: "Stage a hunk of",
  unstageHunk: "Unstage a hunk of",
  discardHunk: "Discard a hunk of",
  stageLines: "Stage lines of",
  unstageLines: "Unstage lines of",
  discardLines: "Discard lines of",
};

function folderOf(path: string): string[] {
  return path.replace(/\/$/, "").split("/").slice(0, -1);
}

function sharedFolder(paths: readonly string[]): string {
  const [first = [], ...rest] = paths.map(folderOf);
  let length = first.length;
  for (const folder of rest) {
    let same = 0;
    while (same < length && folder[same] === first[same]) same++;
    length = same;
  }
  return first.slice(0, length).join("/");
}

export function describe(operation: Operation): string {
  switch (operation.kind) {
    case "createBranch":
      return `Create branch ${operation.name}`;
    case "renameBranch":
      return `Rename branch ${branchName(operation.branch)} to ${operation.to}`;
    case "deleteBranch":
      return `Delete branch ${branchName(operation.branch)}`;
  }
  if ("message" in operation)
    return `${commitVerbs[operation.kind]} ${quoted(operation.message)}`;
  if ("shown" in operation)
    return `${partVerbs[operation.kind]} ${operation.path}`;
  const paths = operation.entries.map((entry) => entry.path);
  const resolving =
    operation.kind === "stageFiles" &&
    operation.entries.every((entry) => entry.kind === "unmerged");
  const folder = sharedFolder(paths);
  const files =
    paths.length === 1
      ? paths[0]
      : `${paths.length.toLocaleString()} files${folder === "" ? "" : ` in ${folder}`}`;
  if (resolving) return `Mark ${files} resolved`;
  return `${fileVerbs[operation.kind]} ${files}`;
}

export type Step = "undo" | "redo";

export type HistoryEntry = Applied & { label: string };

export type History =
  | { kind: "unread" }
  | { kind: "read"; undo: HistoryEntry | null; redo: HistoryEntry | null }
  | { kind: "unreadable"; problem: Problem };

export const nextEntry = (history: History, step: Step) =>
  history.kind === "read" ? history[step] : null;

export const historyFailure = (problem: Problem) =>
  `Undo and redo are unavailable. ${problem.message}`;

const stepNames = { undo: "Undo", redo: "Redo" } as const;

export function stepButton(
  history: History,
  step: Step,
  shortcut: string,
): { name: string; title: string } {
  const name = stepNames[step];
  if (history.kind === "unread")
    return { name, title: "Reading the undo history" };
  if (history.kind === "unreadable")
    return {
      name,
      title: `${name} is unavailable. ${history.problem.message}`,
    };
  const entry = history[step];
  if (entry === null) return { name, title: `Nothing to ${step}` };
  return {
    name: `${name} ${entry.label}`,
    title: `${name} ${entry.label} (${shortcut})`,
  };
}

export type WriteNotice =
  | { kind: "stepped"; step: Step; label: string }
  | {
      kind: "failed";
      action: "write";
      label: string;
      problem: Problem;
      operation: Operation;
    }
  | {
      kind: "failed";
      action: Step;
      label: string;
      problem: Problem;
      entry: EntryId;
    };

export type StaleReason = Extract<Problem, { kind: "staleView" }>["reason"];

type KnownStale = Exclude<
  Extract<Problem, { kind: "staleView" }>,
  { reason: "unknown" }
>;

export const rereadsRepository = (problem: Problem) =>
  problem.kind === "staleView" &&
  (problem.reason === "headMoved" || problem.reason === "branchChanged");

function listed(paths: readonly string[]): string {
  const shown =
    paths.length <= 3
      ? paths
      : [
          ...paths.slice(0, 2),
          `${(paths.length - 2).toLocaleString()} more files`,
        ];
  return new Intl.ListFormat("en").format(shown);
}

function staleCause(problem: KnownStale, step: Step | null): string {
  switch (problem.reason) {
    case "headMoved":
      return step === null
        ? "HEAD moved since L1 Git read this worktree."
        : `HEAD moved after this change, so L1 Git cannot ${step} it exactly.`;
    case "pathChanged":
    case "branchChanged":
      return problem.message;
    case "pathNotChosen": {
      const { paths } = problem;
      const one = paths.length === 1;
      return step === null
        ? `Git would also change ${listed(paths)}, which ${one ? "was" : "were"} not chosen.`
        : `Git would also change ${listed(paths)}, which ${one ? "is" : "are"} outside this change, so L1 Git cannot ${step} it.`;
    }
    case "stagedChanged":
      return "The staged files changed since L1 Git showed them.";
    case "historyChanged":
      return "The undo history changed since L1 Git showed it.";
  }
}

const lowerFirst = (text: string) =>
  text.charAt(0).toLowerCase() + text.slice(1);

export function failureText(
  notice: Extract<WriteNotice, { kind: "failed" }>,
  history: History,
): string {
  const { action, label, problem } = notice;
  const what =
    action === "write"
      ? `Could not ${lowerFirst(label)}.`
      : `Could not ${action} ${label}.`;
  if (problem.kind === "raced") return problem.message;
  if (problem.kind !== "staleView" || problem.reason === "unknown")
    return `${what} ${problem.message}`;
  if (action === "write") {
    const part = "shown" in notice.operation;
    if (part && problem.reason === "pathChanged")
      return `${what} The file changed since L1 Git showed its diff. L1 Git reread the diff, so check it and try again.`;
    if (
      problem.reason === "pathChanged" ||
      problem.reason === "branchChanged" ||
      (part && problem.reason === "pathNotChosen")
    )
      return `${what} ${problem.message}`;
    return `${what} ${staleCause(problem, null)} L1 Git reread the worktree, so check the lists and try again.`;
  }
  const cause = `${what} ${staleCause(problem, action)}`;
  if (history.kind !== "read") return cause;
  const then =
    history[action]?.id !== notice.entry
      ? "L1 Git reread the undo history."
      : action === "undo"
        ? "Undo goes in order, so older changes stay blocked until this one can be undone."
        : "Redo stays blocked until this one can be redone. A new change clears it.";
  return `${cause} ${then}`;
}
