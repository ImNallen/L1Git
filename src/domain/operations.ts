import type {
  Applied,
  EntryId,
  Expect,
  Operation,
  Problem,
  WorktreeStatus,
} from "./repository";

export type FileWrite = Operation["kind"];

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
  return `${operation.kind === "stageFiles" ? "Stage" : "Unstage"} ${files}`;
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
  | { kind: "failed"; action: "write"; label: string; problem: Problem }
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
  problem.kind === "staleView" && problem.reason === "headMoved";

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
      return problem.message;
    case "pathNotChosen": {
      const { paths } = problem;
      const one = paths.length === 1;
      return step === null
        ? `Git would also change ${listed(paths)}, which ${one ? "was" : "were"} not chosen.`
        : `Git would also change ${listed(paths)}, which ${one ? "is" : "are"} outside this change, so L1 Git cannot ${step} it.`;
    }
    case "historyChanged":
      return "The undo history changed since L1 Git showed it.";
  }
}

const lowerFirst = (text: string) =>
  text.charAt(0).toLowerCase() + text.slice(1);

export function failureText(
  notice: Extract<WriteNotice, { kind: "failed" }>,
  blocking: boolean,
): string {
  const { action, label, problem } = notice;
  const what =
    action === "write"
      ? `Could not ${lowerFirst(label)}.`
      : `Could not ${action} ${label}.`;
  if (problem.kind !== "staleView" || problem.reason === "unknown")
    return `${what} ${problem.message}`;
  if (action === "write")
    return problem.reason === "pathChanged"
      ? `${what} ${problem.message}`
      : `${what} ${staleCause(problem, null)} L1 Git reread the worktree, so check the lists and try again.`;
  const then = !blocking
    ? "L1 Git reread the undo history."
    : action === "undo"
      ? "Undo goes in order, so older changes stay blocked until this one can be undone."
      : "Redo stays blocked until this one can be redone. A new change clears it.";
  return `${what} ${staleCause(problem, action)} ${then}`;
}
