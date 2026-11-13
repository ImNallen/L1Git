import { z } from "zod";
import { oidSchema, refSchema, rootSchema } from "./repository";
import type { Branch, FullRef, Oid, RepositoryRoot } from "./repository";
import { shortRemote } from "./refs";

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
const branchRoleSchema = z.enum(["default", "mainline", "other"]);
export const branchStatusSchema = z.object({
  reference: branchRefSchema,
  name: z.string(),
  oid: oidSchema,
  role: branchRoleSchema,
  checkedOutAt: rootSchema.nullable(),
  state: branchStateSchema,
});
const fetchFailureSchema = z.enum([
  "auth",
  "network",
  "timedOut",
  "busy",
  "other",
]);
const fetchSummarySchema = z.object({
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
const advanceOutcomeSchema = z.discriminatedUnion("kind", [
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
type BranchState = z.infer<typeof branchStateSchema>;
export type BranchStatus = z.infer<typeof branchStatusSchema>;
export type FetchSummary = z.infer<typeof fetchSummarySchema>;
export type RepositoryOverview = z.infer<typeof overviewSchema>;
export type AdvanceOutcome = z.infer<typeof advanceOutcomeSchema>;
export type FastForwardReport = z.infer<typeof fastForwardReportSchema>;
/** `branch` fetches only the remote branch behind a local branch's upstream, or behind a remote-tracking branch. */
export type FetchMode = "local" | "remote" | { branch: FullRef | BranchRef };
export type Advance = { reference: BranchRef; from: Oid; to: Oid };
export type Divergence = { upstream: FullRef; ahead: number; behind: number };

export function divergence(state: BranchState): Divergence | null {
  switch (state.kind) {
    case "untracked":
    case "gone":
      return null;
    case "upToDate":
      return { upstream: state.upstream, ahead: 0, behind: 0 };
    case "ahead":
      return { upstream: state.upstream, ahead: state.ahead, behind: 0 };
    case "behind":
      return { upstream: state.upstream, ahead: 0, behind: state.behind };
    case "diverged":
      return {
        upstream: state.upstream,
        ahead: state.ahead,
        behind: state.behind,
      };
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

/** How Pull joins a branch that has diverged from its upstream. */
export type PullMode = "ffIfPossible" | "ffOnly" | "rebase";

/** What Pull does once it has fetched the branch's upstream. */
export type PullStep =
  | { kind: "nothing" }
  | { kind: "fastForward"; advance: Advance }
  | { kind: "refuse"; reason: string }
  | { kind: "merge" }
  | { kind: "rebase"; onto: FullRef };

const onDiverged: Record<PullMode, (upstream: FullRef) => PullStep> = {
  ffIfPossible: () => ({ kind: "merge" }),
  ffOnly: () => ({
    kind: "refuse",
    reason:
      "It has diverged from its upstream. Use Pull (Fast-forward if possible) to merge instead.",
  }),
  rebase: (upstream) => ({ kind: "rebase", onto: upstream }),
};

/** `branch` is the fresh status of the branch Pull started on in `root`. */
export function pullStep(
  branch: BranchStatus | undefined,
  root: RepositoryRoot,
  mode: PullMode,
): PullStep {
  if (branch?.checkedOutAt !== root)
    return {
      kind: "refuse",
      reason: "It is no longer checked out here. Refresh and pull again.",
    };
  const { state } = branch;
  switch (state.kind) {
    case "untracked":
      return { kind: "refuse", reason: "It has no upstream." };
    case "gone":
      return {
        kind: "refuse",
        reason: `Its upstream ${shortRemote(state.upstream)} is gone.`,
      };
    case "upToDate":
    case "ahead":
      return { kind: "nothing" };
    case "behind":
      return {
        kind: "fastForward",
        advance: {
          reference: branch.reference,
          from: branch.oid,
          to: state.target,
        },
      };
    case "diverged":
      return onDiverged[mode](state.upstream);
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

/** The checked-out branch Pull updates, or why it cannot. */
export type PullTarget =
  | { kind: "ready"; branch: BranchRef; name: string; upstream: string }
  | { kind: "unavailable"; reason: string };

/** `branch` is the branch checked out in the worktree Pull acts on. */
export function pullTarget(
  branch: BranchStatus | undefined,
  busy: string | null,
): PullTarget {
  if (!branch)
    return {
      kind: "unavailable",
      reason: "Check out a branch to pull into it.",
    };
  const { state } = branch;
  if (state.kind === "untracked" || !state.upstream.startsWith("refs/remotes/"))
    return {
      kind: "unavailable",
      reason: `${branch.name} has no upstream on a remote. Publish it first.`,
    };
  if (state.kind === "gone")
    return {
      kind: "unavailable",
      reason: `The upstream of ${branch.name}, ${shortRemote(state.upstream)}, is gone.`,
    };
  if (busy) return { kind: "unavailable", reason: busy };
  return {
    kind: "ready",
    branch: branch.reference,
    name: branch.name,
    upstream: shortRemote(state.upstream),
  };
}

/** The branch a sync command acts on, or why it cannot act. */
export type SyncTarget =
  | { kind: "ready"; branch: FullRef; detail: string }
  | { kind: "unavailable"; reason: string };

/** Fetch takes the selected branch, else the checked-out one. */
export function fetchTarget(
  selected: Branch | null,
  current: Branch | null,
): SyncTarget {
  const branch = selected ?? current;
  if (branch === null)
    return {
      kind: "unavailable",
      reason: "Select a branch to fetch it, or use Fetch all.",
    };
  if (branch.kind === "remote")
    return {
      kind: "ready",
      branch: branch.reference,
      detail: `Fetch ${branch.name}.`,
    };
  if (branch.upstream?.startsWith("refs/remotes/"))
    return {
      kind: "ready",
      branch: branch.reference,
      detail: `Fetch ${shortRemote(branch.upstream)}, the upstream of ${branch.name}.`,
    };
  return {
    kind: "unavailable",
    reason: `${branch.name} has no upstream on a remote, so there is nothing to fetch for it. Use Fetch all.`,
  };
}

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

function needsAttention(branch: BranchStatus): boolean {
  return attentionOrder[branch.state.kind] < attentionOrder.upToDate;
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
