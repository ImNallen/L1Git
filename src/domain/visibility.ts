import type { Commit, FullRef, Oid, RepositorySnapshot } from "./repository";

/** Hiding removes branches from the graph's tips. Soloing keeps only the soloed ones and HEAD. */
export type VisibilityRule =
  | { kind: "none" }
  | { kind: "hide" | "solo"; refs: ReadonlySet<FullRef> };

export type BranchVisibility = "shown" | "hidden" | "soloed";

export const NO_RULE: VisibilityRule = { kind: "none" };

export function branchVisibility(
  rule: VisibilityRule,
  reference: FullRef,
): BranchVisibility {
  if (rule.kind === "none" || !rule.refs.has(reference)) return "shown";
  return rule.kind === "hide" ? "hidden" : "soloed";
}

/** Toggles `reference` in a rule of `kind`, replacing a rule of the other kind. */
export function toggleRule(
  rule: VisibilityRule,
  kind: "hide" | "solo",
  reference: FullRef,
): VisibilityRule {
  if (rule.kind !== kind) return { kind, refs: new Set([reference]) };
  const refs = new Set(rule.refs);
  if (!refs.delete(reference)) refs.add(reference);
  return refs.size === 0 ? NO_RULE : { kind, refs };
}

/** The smallest change to `rule` that shows the tip of `reference`. */
export function revealBranch(
  rule: VisibilityRule,
  reference: FullRef,
): VisibilityRule {
  if (rule.kind === "none") return rule;
  if (rule.kind === "solo")
    return rule.refs.has(reference)
      ? rule
      : toggleRule(rule, "solo", reference);
  return rule.refs.has(reference) ? toggleRule(rule, "hide", reference) : rule;
}

type Refs = Pick<
  RepositorySnapshot,
  "head" | "branches" | "tags" | "worktrees"
>;

function tips(refs: Refs, rule: VisibilityRule): Oid[] | null {
  const head = refs.head.kind === "unborn" ? [] : [refs.head.oid];
  if (rule.kind === "solo") {
    const soloed = refs.branches.filter((branch) =>
      rule.refs.has(branch.reference),
    );
    if (soloed.length === 0) return null;
    return [...head, ...soloed.map((branch) => branch.oid)];
  }
  if (rule.kind === "hide")
    return [
      ...head,
      ...refs.branches
        .filter((branch) => !rule.refs.has(branch.reference))
        .map((branch) => branch.oid),
      ...refs.tags.map((tag) => tag.oid),
      ...refs.worktrees.flatMap((worktree) =>
        worktree.head.kind === "unborn" ? [] : [worktree.head.oid],
      ),
    ];
  return null;
}

/**
 * The commits reachable from the tips `rule` leaves visible, in their original
 * order. A solo rule whose branches are all gone shows everything.
 */
export function visibleCommits<C extends Pick<Commit, "oid" | "parents">>(
  commits: readonly C[],
  refs: Refs,
  rule: VisibilityRule,
): readonly C[] {
  const pending = tips(refs, rule);
  if (pending === null) return commits;
  const parents = new Map(
    commits.map((commit) => [commit.oid, commit.parents]),
  );
  const reached = new Set<Oid>();
  for (let oid = pending.pop(); oid !== undefined; oid = pending.pop()) {
    const next = parents.get(oid);
    if (next === undefined || reached.has(oid)) continue;
    reached.add(oid);
    pending.push(...next);
  }
  return reached.size === commits.length
    ? commits
    : commits.filter((commit) => reached.has(commit.oid));
}
