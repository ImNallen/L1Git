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
  FullRef,
  Head,
  LinePick,
  Oid,
  Operation,
  Problem,
  Start,
  StatusEntry,
  Tag,
  WorktreePatch,
  WorktreeStatus,
} from "./repository";

type FileOperation = Extract<Operation, { entries: unknown }>;
type BranchOperation = Extract<
  Operation,
  { kind: "createBranch" | "renameBranch" | "deleteBranch" }
>;
type TagOperation = Extract<Operation, { kind: "createTag" | "deleteTag" }>;
type CommitOperation = Extract<
  Operation,
  { kind: "commit" | "amend" | "editMessage" }
>;
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
  "message" in operation ||
  isBranchOperation(operation) ||
  isTagOperation(operation) ||
  operation.kind === "checkout";

export type BranchAsk =
  | { kind: "create"; at: Start; from: string }
  | { kind: "rename"; branch: BranchTip; name: string }
  | { kind: "delete"; branch: BranchTip; name: string };

export const startAt = ({ kind, reference, oid }: Branch): Start =>
  kind === "local"
    ? { kind: "local", reference, oid }
    : { kind: "remote", reference, oid };

export function branchAsks(branch: Branch): {
  create: BranchAsk;
  rename: BranchAsk | null;
  delete: BranchAsk | null;
} {
  const { reference, oid, name } = branch;
  const create: BranchAsk = { kind: "create", at: startAt(branch), from: name };
  if (branch.kind === "remote") return { create, rename: null, delete: null };
  const tip = { reference, oid };
  return {
    create,
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

export const localBranch = (name: string, oid: Oid): Branch => ({
  kind: "local",
  reference: `refs/heads/${name}` as FullRef,
  name,
  oid,
  upstream: null,
});

export type BranchStep = { left: Branch | null; gone: FullRef | null };

export function branchStep(operation: BranchOperation, step: Step): BranchStep {
  const named = (name: string) => `refs/heads/${name}` as FullRef;
  switch (operation.kind) {
    case "createBranch": {
      const { name, at } = operation;
      return step === "undo"
        ? { left: null, gone: named(name) }
        : { left: localBranch(name, at.oid), gone: null };
    }
    case "renameBranch": {
      const { branch, to } = operation;
      const [from, into] =
        step === "undo" ? [to, branchName(branch)] : [branchName(branch), to];
      return { left: localBranch(into, branch.oid), gone: named(from) };
    }
    case "deleteBranch": {
      const { branch } = operation;
      return step === "undo"
        ? { left: localBranch(branchName(branch), branch.oid), gone: null }
        : { left: null, gone: branch.reference };
    }
  }
}

export type RefStep = { left: FullRef | null; gone: FullRef | null };

export function refStep(operation: Operation, step: Step): RefStep | null {
  if (isBranchOperation(operation)) {
    const { left, gone } = branchStep(operation, step);
    return { left: left?.reference ?? null, gone };
  }
  if (!isTagOperation(operation)) return null;
  const reference =
    operation.kind === "createTag"
      ? (`refs/tags/${operation.name}` as FullRef)
      : operation.tag.reference;
  return (operation.kind === "createTag") === (step === "redo")
    ? { left: reference, gone: null }
    : { left: null, gone: reference };
}

export type TagAsk =
  | { kind: "create"; at: Oid; subject: string }
  | { kind: "delete"; tag: Tag };

export const isTagOperation = (
  operation: Operation,
): operation is TagOperation =>
  operation.kind === "createTag" || operation.kind === "deleteTag";

export const createTagWrite = (
  name: string,
  at: Oid,
  message: string,
  head: Head,
): Write => ({
  operation: {
    kind: "createTag",
    name,
    at,
    message: message.trim() === "" ? null : message,
  },
  expect: { head },
});

export const answeredInTagDialog = ({ kind }: Problem) =>
  kind === "invalidRef" || kind === "gitFailed" || kind === "missingIdentity";

export const deleteTagWrite = (tag: Tag, head: Head): Write => ({
  operation: {
    kind: "deleteTag",
    tag: { reference: tag.reference, oid: tag.object },
  },
  expect: { head },
});

export const branchWrite = (operation: BranchOperation, head: Head): Write => ({
  operation,
  expect: { head },
});

export const checkoutWrite = (target: Start, head: Head): Write => ({
  operation: { kind: "checkout", target },
  expect: { head },
});

const branchName = (branch: BranchTip) =>
  branch.reference.replace(/^refs\/heads\//, "");

const startName = (start: Start) =>
  start.kind === "commit"
    ? start.oid.slice(0, 7)
    : start.reference.replace(/^refs\/(?:heads|remotes)\//, "");

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
    case "checkout":
      return `Check out ${startName(operation.target)}`;
    case "createTag":
      return `Create tag ${operation.name}`;
    case "deleteTag":
      return `Delete tag ${operation.tag.reference.replace(/^refs\/tags\//, "")}`;
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

export const steppedText = ({
  step,
  label,
}: Extract<WriteNotice, { kind: "stepped" }>) =>
  `${step === "undo" ? "Undid" : "Redid"} ${label}`;

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
  (problem.reason === "headMoved" ||
    problem.reason === "branchChanged" ||
    problem.reason === "tagChanged");

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
    case "tagChanged":
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

const HOOK_LINES = 3;

export const hookOutputTail = (problem: Problem): string[] =>
  problem.kind === "afterHookFailed"
    ? problem.output
        .split(/\r?\n|\r/)
        .filter((line) => line.trim() !== "")
        .slice(-HOOK_LINES)
    : [];

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
  if (problem.kind === "raced" || problem.kind === "afterHookFailed")
    return problem.message;
  if (problem.kind !== "staleView" || problem.reason === "unknown")
    return `${what} ${problem.message}`;
  if (action === "write") {
    const part = "shown" in notice.operation;
    if (part && problem.reason === "pathChanged")
      return `${what} The file changed since L1 Git showed its diff. L1 Git reread the diff, so check it and try again.`;
    if (
      problem.reason === "pathChanged" ||
      problem.reason === "branchChanged" ||
      problem.reason === "tagChanged" ||
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
