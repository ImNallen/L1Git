import { z } from "zod";
import { oidSchema, refSchema, rootSchema } from "./repository";
import type { Oid } from "./repository";

export const branchRefSchema = z
  .string()
  .regex(/^refs\/heads\/.+$/)
  .brand<"BranchRef">();
const count = z.number().int().positive();
const blockerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("dirty"), worktree: rootSchema }),
  z.object({ kind: z.literal("inUse"), worktree: rootSchema }),
  z.object({ kind: z.literal("unverified"), message: z.string() }),
]);
export const branchStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("untracked") }),
  z.object({ kind: z.literal("gone"), upstream: refSchema }),
  z.object({ kind: z.literal("upToDate"), upstream: refSchema }),
  z.object({ kind: z.literal("ahead"), upstream: refSchema, ahead: count }),
  z.object({
    kind: z.literal("diverged"),
    upstream: refSchema,
    ahead: count,
    behind: count,
  }),
  z.object({
    kind: z.literal("behind"),
    upstream: refSchema,
    target: oidSchema,
    behind: count,
    blocker: blockerSchema.nullable(),
  }),
]);
export const branchRoleSchema = z.enum(["default", "mainline", "other"]);
export const branchStatusSchema = z.object({
  reference: branchRefSchema,
  name: z.string(),
  oid: oidSchema,
  role: branchRoleSchema,
  checkedOutAt: rootSchema.nullable(),
  state: branchStateSchema,
});
export const fetchFailureSchema = z.enum([
  "auth",
  "network",
  "timedOut",
  "busy",
  "other",
]);
export const fetchSummarySchema = z.object({
  at: z.number().int().nonnegative(),
  changed: z.boolean(),
  coalesced: z.boolean(),
  remotes: z.array(
    z.object({
      remote: z.string(),
      outcome: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("fetched") }),
        z.object({ kind: z.literal("skipped") }),
        z.object({
          kind: z.literal("failed"),
          failure: fetchFailureSchema,
          message: z.string(),
        }),
      ]),
    }),
  ),
});
export const overviewSchema = z.object({
  root: rootSchema,
  commonDir: rootSchema,
  name: z.string(),
  branches: z.array(branchStatusSchema),
  fetch: fetchSummarySchema.nullable(),
  observedAt: z.number().int().nonnegative(),
});
const skipReasonSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("changed") }),
  z.object({ kind: z.literal("notBehind") }),
  z.object({ kind: z.literal("dirty"), worktree: rootSchema }),
  z.object({ kind: z.literal("inUse"), worktree: rootSchema }),
  z.object({ kind: z.literal("failed"), message: z.string() }),
]);
export const advanceOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("advanced"),
    reference: branchRefSchema,
    from: oidSchema,
    to: oidSchema,
  }),
  z.object({
    kind: z.literal("skipped"),
    reference: branchRefSchema,
    reason: skipReasonSchema,
  }),
]);
export const fastForwardReportSchema = z.object({
  outcomes: z.array(advanceOutcomeSchema),
  overview: overviewSchema,
});

export type BranchRef = z.infer<typeof branchRefSchema>;
export type BranchState = z.infer<typeof branchStateSchema>;
export type BranchRole = z.infer<typeof branchRoleSchema>;
export type BranchStatus = z.infer<typeof branchStatusSchema>;
export type FetchSummary = z.infer<typeof fetchSummarySchema>;
export type RepositoryOverview = z.infer<typeof overviewSchema>;
export type AdvanceOutcome = z.infer<typeof advanceOutcomeSchema>;
export type FastForwardReport = z.infer<typeof fastForwardReportSchema>;
export type FetchMode = "local" | "remote";
export type Advance = { reference: BranchRef; from: Oid; to: Oid };

export function readyAdvances(overview: RepositoryOverview): Advance[] {
  return overview.branches.flatMap((branch) =>
    branch.state.kind === "behind" && branch.state.blocker === null
      ? [
          {
            reference: branch.reference,
            from: branch.oid,
            to: branch.state.target,
          },
        ]
      : [],
  );
}

const attentionOrder: Record<BranchState["kind"], number> = {
  behind: 0,
  diverged: 1,
  gone: 2,
  ahead: 3,
  upToDate: 4,
  untracked: 4,
};
const roleOrder: Record<BranchRole, number> = {
  default: 0,
  mainline: 1,
  other: 2,
};

function needsAttention(branch: BranchStatus): boolean {
  return attentionOrder[branch.state.kind] < attentionOrder.upToDate;
}

export function attentionRows(overview: RepositoryOverview): {
  rows: BranchStatus[];
  hiddenUpToDate: number;
} {
  const shown = (branch: BranchStatus) =>
    branch.role !== "other" || needsAttention(branch);
  const rows = overview.branches
    .filter(shown)
    .sort(
      (a, b) =>
        roleOrder[a.role] - roleOrder[b.role] ||
        attentionOrder[a.state.kind] - attentionOrder[b.state.kind],
    );
  const hiddenUpToDate = overview.branches.filter(
    (branch) => !shown(branch) && branch.state.kind === "upToDate",
  ).length;
  return { rows, hiddenUpToDate };
}

export function repositoryRank(
  overview: RepositoryOverview,
  fetchFailed: boolean,
): number {
  if (
    overview.branches.some(
      (branch) => branch.role !== "other" && branch.state.kind === "behind",
    )
  )
    return 0;
  if (fetchFailed) return 1;
  if (overview.branches.some(needsAttention)) return 2;
  return 3;
}
