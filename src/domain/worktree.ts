import type { GitStatus } from "@pierre/trees";
import { firstChangedPath } from "./changedFiles";
import { worktreeRowId } from "./graph";
import type { WorktreeRowId } from "./graph";
import type {
  ChangeStatus,
  Commit,
  Conflict,
  Oid,
  Problem,
  RepositoryRoot,
  Side,
  StatusEntry,
  Worktree,
  WorktreeStatus,
} from "./repository";

export type WorktreeChanges =
  | { kind: "ready"; status: WorktreeStatus }
  | { kind: "error"; error: Problem };

export type ChangesByWorktree = ReadonlyMap<RepositoryRoot, WorktreeChanges>;

export type WorktreeRow = {
  kind: "worktree";
  id: WorktreeRowId;
  parents: readonly Oid[];
  worktree: Worktree;
  changes: WorktreeChanges;
};

export type HistoryRow =
  | { kind: "commit"; id: Oid; parents: readonly Oid[]; commit: Commit }
  | WorktreeRow;

export function hasRow(changes: WorktreeChanges): boolean {
  return changes.kind === "error" || changes.status.entries.length > 0;
}

export function historyRows(
  commits: readonly Commit[],
  worktrees: readonly Worktree[],
  changes: ChangesByWorktree,
): HistoryRow[] {
  const first: WorktreeRow[] = [];
  const above = new Map<Oid, WorktreeRow[]>();
  for (const worktree of worktrees) {
    const found = changes.get(worktree.root);
    if (found === undefined || !hasRow(found)) continue;
    const head = worktree.head.kind === "unborn" ? null : worktree.head.oid;
    const row: WorktreeRow = {
      kind: "worktree",
      id: worktreeRowId(worktree.root),
      parents: head === null ? [] : [head],
      worktree,
      changes: found,
    };
    if (head === null) first.push(row);
    else above.set(head, [...(above.get(head) ?? []), row]);
  }
  const rows: HistoryRow[] = first;
  for (const commit of commits) {
    const worktreeRows = above.get(commit.oid);
    if (worktreeRows) rows.push(...worktreeRows);
    rows.push({
      kind: "commit",
      id: commit.oid,
      parents: commit.parents,
      commit,
    });
  }
  return rows;
}

export type WorktreeFile = { path: string; status: GitStatus };

export type ListSide = Side | "conflict";

export function patchSide(side: ListSide): Side {
  return side === "conflict" ? "unstaged" : side;
}

export type WorktreeGroup = {
  title: "Conflicts" | "Unstaged" | "Staged";
  side: ListSide;
  files: WorktreeFile[];
};

export const listWrites: Record<
  ListSide,
  { kind: "stageFiles" | "unstageFiles"; row: string; all: string | null }
> = {
  conflict: { kind: "stageFiles", row: "Mark resolved", all: null },
  unstaged: { kind: "stageFiles", row: "Stage", all: "Stage all" },
  staged: { kind: "unstageFiles", row: "Unstage", all: "Unstage all" },
};

export const treeStatus = {
  A: "added",
  D: "deleted",
  M: "modified",
  T: "modified",
} as const satisfies Record<ChangeStatus, GitStatus>;

export function worktreeGroups(
  entries: readonly StatusEntry[],
): WorktreeGroup[] {
  const conflicts: WorktreeFile[] = [];
  const unstaged: WorktreeFile[] = [];
  const staged: WorktreeFile[] = [];
  for (const entry of entries) {
    switch (entry.kind) {
      case "ordinary": {
        const { path, sides } = entry;
        if (sides.kind !== "unstaged")
          staged.push({ path, status: treeStatus[sides.staged] });
        if (sides.kind !== "staged")
          unstaged.push({ path, status: treeStatus[sides.unstaged] });
        break;
      }
      case "renamed": {
        const moved: WorktreeFile = {
          path: entry.path,
          status: entry.how === "renamed" ? "renamed" : "added",
        };
        if (entry.side.kind === "unstaged") {
          unstaged.push(moved);
          break;
        }
        staged.push(moved);
        if (entry.side.unstaged !== null)
          unstaged.push({
            path: entry.path,
            status: treeStatus[entry.side.unstaged],
          });
        break;
      }
      case "untracked":
        unstaged.push({ path: entry.path, status: "untracked" });
        break;
      case "unmerged":
        conflicts.push({ path: entry.path, status: "modified" });
        break;
      default: {
        const exhaustive: never = entry;
        return exhaustive;
      }
    }
  }
  return [
    { title: "Conflicts", side: "conflict", files: conflicts },
    { title: "Unstaged", side: "unstaged", files: unstaged },
    { title: "Staged", side: "staged", files: staged },
  ];
}

export function firstWorktreeFile(
  groups: readonly WorktreeGroup[],
): { path: string; side: ListSide } | null {
  for (const { files, side } of groups) {
    const path = firstChangedPath(files);
    if (path !== undefined) return { path, side };
  }
  return null;
}

export type DiffAfter =
  | { kind: "reread" }
  | { kind: "follow"; side: ListSide }
  | { kind: "close" };

export function openDiffAfter(
  entries: readonly StatusEntry[],
  path: string,
  side: ListSide,
): DiffAfter {
  const sides = worktreeGroups(entries)
    .filter((group) => group.files.some((file) => file.path === path))
    .map((group) => group.side);
  if (sides.includes(side)) return { kind: "reread" };
  const [other] = sides;
  return other === undefined
    ? { kind: "close" }
    : { kind: "follow", side: other };
}

const summaryOrder = [
  "conflicted",
  "modified",
  "added",
  "deleted",
  "renamed",
  "copied",
  "untracked",
] as const;
type SummaryKind = (typeof summaryOrder)[number];

function summaryKind(entry: StatusEntry): SummaryKind {
  switch (entry.kind) {
    case "unmerged":
      return "conflicted";
    case "untracked":
      return "untracked";
    case "renamed":
      return entry.how === "copied" ? "copied" : "renamed";
    case "ordinary": {
      const code =
        entry.sides.kind === "staged"
          ? entry.sides.staged
          : entry.sides.unstaged;
      return code === "A" ? "added" : code === "D" ? "deleted" : "modified";
    }
    default: {
      const exhaustive: never = entry;
      return exhaustive;
    }
  }
}

export function changeSummary(entries: readonly StatusEntry[]): string {
  const counts = new Map<SummaryKind, number>();
  for (const entry of entries) {
    const kind = summaryKind(entry);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return summaryOrder
    .flatMap((kind) => {
      const count = counts.get(kind);
      return count === undefined ? [] : [`${count.toLocaleString()} ${kind}`];
    })
    .join(", ");
}

export const conflictLabels: Record<Conflict, string> = {
  bothDeleted: "Deleted by both",
  addedByUs: "Added by us",
  deletedByThem: "Deleted by them",
  addedByThem: "Added by them",
  deletedByUs: "Deleted by us",
  bothAdded: "Added by both",
  bothModified: "Modified by both",
};

const MESSAGE_LINES = 12;
const MESSAGE_CHARACTERS = 2000;

export function clampMessage(message: string): string {
  const lines = message.trimEnd().split("\n");
  let text = lines.slice(0, MESSAGE_LINES).join("\n");
  if (text.length > MESSAGE_CHARACTERS)
    text = text.slice(0, MESSAGE_CHARACTERS);
  return text.length < message.trimEnd().length ? `${text}\n…` : text;
}
