import { mergeReviewSchema, mergeStateSchema } from "../domain/merge";
import type { MergeReview, MergeState } from "../domain/merge";
import { overviewSchema } from "../domain/overview";
import type { RepositoryOverview } from "../domain/overview";
import { pushAvailabilitySchema } from "../domain/push";
import type { PushAvailability } from "../domain/push";
import {
  appliedSchema,
  conflictFileSchema,
  oidSchema,
  snapshotSchema,
  undoHistorySchema,
  worktreeStatusSchema,
} from "../domain/repository";
import type {
  Applied,
  ConflictFile,
  Oid,
  RepositoryRoot,
  RepositorySnapshot,
  UndoHistory,
  WorktreeStatus,
} from "../domain/repository";

export const PIN = "/fixture/pin" as RepositoryRoot;
export const PIN_FEATURE = "/fixture/pin-feature" as RepositoryRoot;
export const OTHER = "/fixture/other" as RepositoryRoot;

const hex = (digit: string) => oidSchema.parse(digit.repeat(40));
export const C1 = hex("1");
export const C2 = hex("2");
export const C3 = hex("3");
export const C4 = hex("4");
export const C5 = hex("5");
export const C6 = hex("6");
export const STASH = hex("7");
export const OTHER_TIP = hex("8");
export const OTHER_STASH = hex("9");
export const OLD = hex("e");
export const STAMP = "a".repeat(40);

const commit = (oid: Oid, parents: Oid[], subject: string, at: number) => ({
  oid,
  parents,
  subject,
  author: "Pin Author",
  email: "pin@example.com",
  timestamp: 1_700_000_000 + at,
});
const local = (name: string, oid: Oid, upstream: string | null = null) => ({
  kind: "local" as const,
  reference: `refs/heads/${name}`,
  name,
  oid,
  upstream,
});
const attached = (name: string, oid: Oid) => ({
  kind: "attached" as const,
  reference: `refs/heads/${name}`,
  oid,
});

export function pinSnapshot(): RepositorySnapshot {
  return snapshotSchema.parse({
    root: PIN,
    name: "pin",
    head: attached("main", C4),
    branches: [
      local("feature", C5),
      local("main", C4, "refs/remotes/origin/main"),
      local("old", OLD),
      local("topic", C6),
      {
        kind: "remote",
        reference: "refs/remotes/origin/main",
        name: "origin/main",
        oid: C3,
        remote: "origin",
      },
    ],
    tags: [
      {
        reference: "refs/tags/v1",
        name: "v1",
        oid: C3,
        object: C3,
        annotated: false,
      },
    ],
    stashes: [
      {
        name: "stash@{0}",
        oid: STASH,
        message: "WIP on main: 4444444 Main tip",
        timestamp: 1_700_000_100,
      },
    ],
    submodules: [],
    worktrees: [
      { root: PIN, name: "pin", head: attached("main", C4), current: true },
      {
        root: PIN_FEATURE,
        name: "pin-feature",
        head: attached("feature", C5),
        current: false,
      },
    ],
    remotes: [
      { name: "origin", url: "https://example.com/pin.git", github: null },
    ],
    commits: [
      commit(C6, [C4], "Topic work", 6),
      commit(C5, [C4], "Feature work", 5),
      commit(C4, [C3], "Main tip", 4),
      commit(C3, [C2], "Release", 3),
      commit(C2, [C1], "Second", 2),
      commit(C1, [], "First", 1),
    ],
    squashes: [],
    historyTruncated: false,
    observedAt: 1_700_000_200,
  });
}

export function otherSnapshot(): RepositorySnapshot {
  return snapshotSchema.parse({
    root: OTHER,
    name: "other",
    head: attached("trunk", OTHER_TIP),
    branches: [local("trunk", OTHER_TIP)],
    tags: [],
    stashes: [
      {
        name: "stash@{0}",
        oid: OTHER_STASH,
        message: "WIP on trunk: 8888888 Other tip",
        timestamp: 1_700_000_100,
      },
    ],
    submodules: [],
    worktrees: [
      {
        root: OTHER,
        name: "other",
        head: attached("trunk", OTHER_TIP),
        current: true,
      },
    ],
    remotes: [],
    commits: [commit(OTHER_TIP, [], "Other tip", 8)],
    squashes: [],
    historyTruncated: false,
    observedAt: 1_700_000_200,
  });
}

const ordinary = (path: string, side: "staged" | "unstaged") => ({
  kind: "ordinary" as const,
  path,
  submodule: null,
  sides:
    side === "staged"
      ? { kind: "staged" as const, staged: "M" as const }
      : { kind: "unstaged" as const, unstaged: "M" as const },
  index: { mode: "100644" as const, oid: C1 },
});

export function status(
  root: RepositoryRoot,
  head: ReturnType<typeof attached>,
  entries: ReturnType<typeof ordinary>[],
): WorktreeStatus {
  return worktreeStatusSchema.parse({
    root,
    head,
    entries,
    stagedStamp: STAMP,
  });
}

export const pinStatus = () =>
  status(PIN, attached("main", C4), [
    ordinary("notes.txt", "unstaged"),
    ordinary("todo.txt", "staged"),
  ]);
export const featureStatus = () =>
  status(PIN_FEATURE, attached("feature", C5), [
    ordinary("feature.txt", "staged"),
  ]);
export const otherStatus = () =>
  status(OTHER, attached("trunk", OTHER_TIP), []);
export const cleanStatus = (root: RepositoryRoot, branch: string, oid: Oid) =>
  status(root, attached(branch, oid), []);
export const unstaged = (path: string) => ordinary(path, "unstaged");
export const staged = (path: string) => ordinary(path, "staged");

let entryCount = 0;
export function applied(root: RepositoryRoot, operation: unknown): Applied {
  entryCount += 1;
  return appliedSchema.parse({
    id: entryCount.toString(16).padStart(16, "0"),
    root,
    operation,
  });
}

export const deleteGoneBranch = () =>
  applied(PIN, {
    kind: "deleteBranch",
    branch: { reference: "refs/heads/gone", oid: C2 },
  });

export function history(
  undo: Applied | null,
  redo: Applied | null = null,
): UndoHistory {
  return undoHistorySchema.parse({ undo, redo });
}

export const idleMerge = (): MergeState =>
  mergeStateSchema.parse({ kind: "idle" });

export function activeMerge(
  root: RepositoryRoot,
  footprint: string[],
): MergeState {
  return mergeStateSchema.parse({
    kind: "active",
    session: {
      id: "f".repeat(16),
      review: {
        root,
        destination: { reference: "refs/heads/feature", oid: C5 },
        source: { reference: "refs/remotes/origin/feature", oid: C6 },
        plan: "mergeCommit",
        context: {
          kind: "upstream",
          tracking: {
            remote: "origin",
            merge: "refs/heads/feature",
            fetch: ["+refs/heads/*:refs/remotes/origin/*"],
          },
        },
      },
      footprint,
      suggestedMessage: "Merge origin/feature into feature",
    },
    unresolved: [],
    staged: STAMP,
    tree: null,
    sourceMoved: false,
  });
}

export function pinOverview(): RepositoryOverview {
  return overviewSchema.parse({
    root: PIN,
    commonDir: "/fixture/pin/.git",
    name: "pin",
    branches: [
      {
        reference: "refs/heads/main",
        name: "main",
        oid: C4,
        role: "default",
        checkedOutAt: PIN,
        state: {
          kind: "diverged",
          upstream: "refs/remotes/origin/main",
          ahead: 1,
          behind: 1,
        },
      },
      {
        reference: "refs/heads/feature",
        name: "feature",
        oid: C5,
        role: "other",
        checkedOutAt: PIN_FEATURE,
        state: {
          kind: "diverged",
          upstream: "refs/remotes/origin/feature",
          ahead: 1,
          behind: 1,
        },
      },
    ],
    fetch: null,
    observedAt: 1_700_000_200,
  });
}

export function otherOverview(): RepositoryOverview {
  return overviewSchema.parse({
    root: OTHER,
    commonDir: "/fixture/other/.git",
    name: "other",
    branches: [
      {
        reference: "refs/heads/trunk",
        name: "trunk",
        oid: OTHER_TIP,
        role: "default",
        checkedOutAt: OTHER,
        state: { kind: "untracked" },
      },
    ],
    fetch: null,
    observedAt: 1_700_000_200,
  });
}

export const PIN_COMMON_DIR = "/fixture/pin/.git" as RepositoryRoot;
export const OTHER_COMMON_DIR = "/fixture/other/.git" as RepositoryRoot;

export const readyPush = (): PushAvailability =>
  pushAvailabilitySchema.parse({
    kind: "ready",
    intent: {
      purpose: "upstream",
      branch: "refs/heads/main",
      source: C4,
      remote: "origin",
      destination: "refs/heads/main",
      endpoint: "https://example.com/pin.git",
      fingerprint: "b".repeat(40),
    },
  });

export const noUpstream = (): PushAvailability =>
  pushAvailabilitySchema.parse({ kind: "unavailable", reason: "noUpstream" });

export function mergeReviewFor(root: RepositoryRoot): MergeReview {
  const branch = root === PIN_FEATURE ? "feature" : "main";
  return mergeReviewSchema.parse({
    root,
    destination: {
      reference: `refs/heads/${branch}`,
      oid: root === PIN_FEATURE ? C5 : C4,
    },
    source: { reference: `refs/remotes/origin/${branch}`, oid: C3 },
    plan: "mergeCommit",
    context: {
      kind: "upstream",
      tracking: {
        remote: "origin",
        merge: `refs/heads/${branch}`,
        fetch: ["+refs/heads/*:refs/remotes/origin/*"],
      },
    },
  });
}

export function editableConflict(root: string, path: string): ConflictFile {
  const stage = (oid: Oid) => ({ mode: "100644", oid });
  return conflictFileSchema.parse({
    kind: "editable",
    snapshot: {
      root,
      path,
      head: attached("main", C4),
      entry: {
        kind: "unmerged",
        path,
        conflict: "bothModified",
        submodule: null,
        stages: { base: stage(C1), ours: stage(C2), theirs: stage(C3) },
      },
      version: "c".repeat(40),
      base: "base\n",
      current: "ours\n",
      incoming: "theirs\n",
      working: "<<<<<<< ours\nours\n=======\ntheirs\n>>>>>>> theirs\n",
    },
  });
}
