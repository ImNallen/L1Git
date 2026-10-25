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

const lowerFirst = (text: string) =>
  text.charAt(0).toLowerCase() + text.slice(1);

const withoutRefresh = (message: string) =>
  message.replace(/\s*Refresh[^.]*\.$/, "");

export function failureText(
  notice: Extract<WriteNotice, { kind: "failed" }>,
  blocking: boolean,
): string {
  const { action, label, problem } = notice;
  const what =
    action === "write"
      ? `Could not ${lowerFirst(label)}.`
      : `Could not ${action} ${label}.`;
  const why = withoutRefresh(problem.message);
  if (problem.kind !== "staleView") return `${what} ${why}`;
  const then =
    action === "write"
      ? "L1 Git reread the worktree, so check the lists and try again."
      : !blocking
        ? "L1 Git reread the undo history."
        : action === "undo"
          ? "Undo goes in order, so older changes stay blocked until this one can be undone."
          : "Redo stays blocked until this one can be redone. A new change clears it.";
  return `${what} ${why} ${then}`;
}
