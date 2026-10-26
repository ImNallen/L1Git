import { z } from "zod";

export const rootSchema = z
  .string()
  .regex(/^(?:\/|[A-Za-z]:[\\/]|\\\\)/)
  .brand<"RepositoryRoot">();
export const oidSchema = z
  .string()
  .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
  .brand<"Oid">();
export const refSchema = z
  .string()
  .regex(/^refs\/.+\/.+$/)
  .brand<"FullRef">();
export const headSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("attached"),
    reference: refSchema,
    oid: oidSchema,
  }),
  z.strictObject({ kind: z.literal("unborn"), reference: refSchema }),
  z.strictObject({ kind: z.literal("detached"), oid: oidSchema }),
]);
export const branchSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("local"),
    reference: refSchema,
    name: z.string(),
    oid: oidSchema,
    upstream: refSchema.nullable(),
  }),
  z.object({
    kind: z.literal("remote"),
    reference: refSchema,
    name: z.string(),
    oid: oidSchema,
    remote: z.string(),
  }),
]);
export const tagSchema = z.object({
  reference: refSchema,
  name: z.string(),
  oid: oidSchema,
});
export const stashSchema = z.object({
  name: z.string(),
  oid: oidSchema,
  message: z.string(),
  timestamp: z.number().int(),
});
export const submoduleSchema = z.object({
  path: z.string(),
  oid: oidSchema,
});
export const worktreeSchema = z.object({
  root: rootSchema,
  name: z.string(),
  head: headSchema,
  current: z.boolean(),
});
export const commitSchema = z.object({
  oid: oidSchema,
  parents: z.array(oidSchema),
  subject: z.string(),
  author: z.string(),
  email: z.string(),
  timestamp: z.number().int(),
});
/** `commit` carries the combined changes of the branch that ends at `tip`. */
export const squashSchema = z.object({ tip: oidSchema, commit: oidSchema });
export const snapshotSchema = z.object({
  root: rootSchema,
  name: z.string(),
  head: headSchema,
  branches: z.array(branchSchema),
  tags: z.array(tagSchema),
  stashes: z.array(stashSchema),
  submodules: z.array(submoduleSchema),
  worktrees: z.array(worktreeSchema),
  remotes: z.array(
    z.object({
      name: z.string(),
      url: z.string(),
      github: z.object({ owner: z.string(), repo: z.string() }).nullable(),
    }),
  ),
  commits: z.array(commitSchema),
  squashes: z.array(squashSchema),
  historyTruncated: z.boolean(),
  observedAt: z.number().int().nonnegative(),
});
export const refsSchema = snapshotSchema.pick({
  root: true,
  name: true,
  head: true,
  branches: true,
  tags: true,
  stashes: true,
  submodules: true,
});
export const changeStatusSchema = z.enum(["A", "D", "M", "T"]);
export const detailSchema = z.object({
  base: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("emptyTree") }),
    z.strictObject({ kind: z.literal("firstParent") }),
    z.strictObject({ kind: z.literal("commit"), commit: commitSchema }),
  ]),
  target: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("commit"),
      commit: commitSchema,
      message: z.string(),
    }),
    z.strictObject({
      kind: z.literal("worktree"),
      root: rootSchema,
      head: headSchema,
    }),
  ]),
  files: z.array(z.object({ path: z.string(), status: changeStatusSchema })),
});
export const filePatchSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("text"),
    patch: z.string(),
    lossy: z.boolean(),
  }),
  z.strictObject({ kind: z.literal("binary") }),
  z.strictObject({
    kind: z.literal("tooLarge"),
    bytes: z.number().int().positive(),
  }),
]);
export const fileHistorySchema = z.array(
  z.strictObject({ commit: commitSchema, path: z.string() }),
);
export const blameRangeSchema = z.strictObject({
  oid: oidSchema,
  start: z.number().int().positive(),
  lines: z.number().int().positive(),
  author: z.string(),
  email: z.string(),
  timestamp: z.number().int(),
  summary: z.string(),
});
export const blameSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("text"),
    contents: z.string(),
    lossy: z.boolean(),
    ranges: z.array(blameRangeSchema),
  }),
  z.strictObject({ kind: z.literal("binary") }),
  z.strictObject({
    kind: z.literal("tooLarge"),
    bytes: z.number().int().positive(),
  }),
]);
export const lineStatsSchema = z.array(
  z.object({
    oid: oidSchema,
    added: z.number().int().nonnegative(),
    deleted: z.number().int().nonnegative(),
  }),
);
export const sidesSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("staged"), staged: changeStatusSchema }),
  z.strictObject({ kind: z.literal("unstaged"), unstaged: changeStatusSchema }),
  z.strictObject({
    kind: z.literal("both"),
    staged: changeStatusSchema,
    unstaged: changeStatusSchema,
  }),
]);
export const submoduleStateSchema = z.strictObject({
  commitChanged: z.boolean(),
  modified: z.boolean(),
  untracked: z.boolean(),
});
export const modeSchema = z.enum(["100644", "100755", "120000", "160000"]);
export const indexObjectSchema = z.strictObject({
  mode: modeSchema,
  oid: oidSchema,
});
export const stagesSchema = z.strictObject({
  base: indexObjectSchema.nullable(),
  ours: indexObjectSchema.nullable(),
  theirs: indexObjectSchema.nullable(),
});
export const moveSideSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("staged"),
    unstaged: changeStatusSchema.nullable(),
    index: indexObjectSchema,
  }),
  z.strictObject({ kind: z.literal("unstaged"), original: indexObjectSchema }),
]);
export const conflictSchema = z.enum([
  "bothDeleted",
  "addedByUs",
  "deletedByThem",
  "addedByThem",
  "deletedByUs",
  "bothAdded",
  "bothModified",
]);
export const statusEntrySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("ordinary"),
    path: z.string(),
    submodule: submoduleStateSchema.nullable(),
    sides: sidesSchema,
    index: indexObjectSchema.nullable(),
  }),
  z.strictObject({
    kind: z.literal("renamed"),
    path: z.string(),
    original: z.string(),
    how: z.enum(["renamed", "copied"]),
    submodule: submoduleStateSchema.nullable(),
    side: moveSideSchema,
  }),
  z.strictObject({
    kind: z.literal("unmerged"),
    path: z.string(),
    conflict: conflictSchema,
    submodule: submoduleStateSchema.nullable(),
    stages: stagesSchema,
  }),
  z.strictObject({ kind: z.literal("untracked"), path: z.string() }),
]);
export const stagedStampSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/)
  .brand<"StagedStamp">();
export const worktreeStatusSchema = z.strictObject({
  root: rootSchema,
  head: headSchema,
  entries: z.array(statusEntrySchema),
  stagedStamp: stagedStampSchema,
});
export const sideSchema = z.enum(["staged", "unstaged"]);
export const worktreePatchSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("diff"), diff: filePatchSchema }),
  z.strictObject({
    kind: z.literal("submodule"),
    submodule: submoduleStateSchema,
  }),
  z.strictObject({
    kind: z.literal("conflicted"),
    conflict: conflictSchema,
    diff: filePatchSchema.nullable(),
  }),
]);
export const entryIdSchema = z
  .string()
  .regex(/^[0-9a-f]{16}$/)
  .brand<"EntryId">();
export const lineSideSchema = z.enum(["deletions", "additions"]);
export const linePickSchema = z.strictObject({
  side: lineSideSchema,
  line: z.number().int().positive(),
});
const hunkPart = {
  path: z.string(),
  hunk: z.number().int().nonnegative(),
  shown: z.string(),
};
const linesPart = {
  path: z.string(),
  lines: z.array(linePickSchema),
  shown: z.string(),
};
export const operationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("stageFiles"),
    entries: z.array(statusEntrySchema),
  }),
  z.strictObject({
    kind: z.literal("unstageFiles"),
    entries: z.array(statusEntrySchema),
  }),
  z.strictObject({
    kind: z.literal("commit"),
    message: z.string(),
    staged: stagedStampSchema,
  }),
  z.strictObject({
    kind: z.literal("amend"),
    message: z.string(),
    staged: stagedStampSchema,
  }),
  z.strictObject({ kind: z.literal("editMessage"), message: z.string() }),
  z.strictObject({
    kind: z.literal("discard"),
    entries: z.array(statusEntrySchema),
  }),
  z.strictObject({ kind: z.literal("stageHunk"), ...hunkPart }),
  z.strictObject({ kind: z.literal("unstageHunk"), ...hunkPart }),
  z.strictObject({ kind: z.literal("stageLines"), ...linesPart }),
  z.strictObject({ kind: z.literal("unstageLines"), ...linesPart }),
  z.strictObject({ kind: z.literal("discardHunk"), ...hunkPart }),
  z.strictObject({ kind: z.literal("discardLines"), ...linesPart }),
]);
export const expectSchema = z.strictObject({ head: headSchema });
export const appliedSchema = z.strictObject({
  id: entryIdSchema,
  root: rootSchema,
  operation: operationSchema,
});
export const undoHistorySchema = z.strictObject({
  undo: appliedSchema.nullable(),
  redo: appliedSchema.nullable(),
});
const staleReasonSchema = z.enum([
  "headMoved",
  "pathChanged",
  "pathNotChosen",
  "stagedChanged",
  "historyChanged",
]);
const staleView = { kind: z.literal("staleView"), message: z.string() };
export const repositoryErrorSchema = z.union([
  z.discriminatedUnion("reason", [
    z.strictObject({
      ...staleView,
      reason: z.literal("pathNotChosen"),
      paths: z.array(z.string()).min(1),
    }),
    z.strictObject({
      ...staleView,
      reason: staleReasonSchema.exclude(["pathNotChosen"]),
    }),
  ]),
  z.object({
    ...staleView,
    reason: z
      .string()
      .refine((reason) => !staleReasonSchema.safeParse(reason).success)
      .transform(() => "unknown" as const),
  }),
  z.object({
    kind: z.enum([
      "missingPath",
      "notRepository",
      "bareRepository",
      "gitMissing",
      "gitFailed",
      "invalidRef",
      "invalidOid",
      "unchangedPath",
      "unsupportedPath",
      "unreadablePath",
      "timedOut",
      "lockHeld",
      "conflict",
      "raced",
    ]),
    message: z.string(),
  }),
  z.object({
    kind: z.enum(["hookFailed", "missingIdentity"]),
    message: z.string(),
    output: z.string(),
  }),
]);

export type RepositoryRoot = z.infer<typeof rootSchema>;
export type Oid = z.infer<typeof oidSchema>;
export type FullRef = z.infer<typeof refSchema>;
export type Head = z.infer<typeof headSchema>;
export type Branch = z.infer<typeof branchSchema>;
export type Tag = z.infer<typeof tagSchema>;
export type Stash = z.infer<typeof stashSchema>;
export type Submodule = z.infer<typeof submoduleSchema>;
export type Worktree = z.infer<typeof worktreeSchema>;
export type Commit = z.infer<typeof commitSchema>;
export type Squash = z.infer<typeof squashSchema>;
export type RepositorySnapshot = z.infer<typeof snapshotSchema>;
export type RepositoryRefs = z.infer<typeof refsSchema>;
export type ChangeStatus = z.infer<typeof changeStatusSchema>;
export type CommitDetail = z.infer<typeof detailSchema>;
export type ChangedFile = CommitDetail["files"][number];
export type FilePatch = z.infer<typeof filePatchSchema>;
export type FileRevision = z.infer<typeof fileHistorySchema>[number];
export type BlameRange = z.infer<typeof blameRangeSchema>;
export type Blame = z.infer<typeof blameSchema>;
export type LineStats = z.infer<typeof lineStatsSchema>[number];
export type Sides = z.infer<typeof sidesSchema>;
export type SubmoduleState = z.infer<typeof submoduleStateSchema>;
export type IndexObject = z.infer<typeof indexObjectSchema>;
export type Stages = z.infer<typeof stagesSchema>;
export type MoveSide = z.infer<typeof moveSideSchema>;
export type Conflict = z.infer<typeof conflictSchema>;
export type StatusEntry = z.infer<typeof statusEntrySchema>;
export type WorktreeStatus = z.infer<typeof worktreeStatusSchema>;
export type StagedStamp = z.infer<typeof stagedStampSchema>;
export type Side = z.infer<typeof sideSchema>;
export type WorktreePatch = z.infer<typeof worktreePatchSchema>;
export type EntryId = z.infer<typeof entryIdSchema>;
export type LineSide = z.infer<typeof lineSideSchema>;
export type LinePick = z.infer<typeof linePickSchema>;
export type Operation = z.infer<typeof operationSchema>;
export type Expect = z.infer<typeof expectSchema>;
export type Applied = z.infer<typeof appliedSchema>;
export type UndoHistory = z.infer<typeof undoHistorySchema>;
export type Problem =
  | z.infer<typeof repositoryErrorSchema>
  | { kind: "transport" | "persistence"; message: string };

export function problemFrom(error: unknown): Problem {
  const repositoryError = repositoryErrorSchema.safeParse(error);
  if (repositoryError.success) return repositoryError.data;
  return {
    kind: "transport",
    message:
      error instanceof Error
        ? error.message
        : "The repository reader is unavailable. Try again.",
  };
}
