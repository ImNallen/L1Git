import type {
  Branch,
  Commit,
  FullRef,
  Oid,
  RepositorySnapshot,
} from "./repository";

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

export function pruneRule(
  rule: VisibilityRule,
  branches: readonly Pick<Branch, "reference">[],
): VisibilityRule {
  if (rule.kind === "none") return rule;
  const live = new Set(branches.map((branch) => branch.reference));
  const refs = new Set(
    [...rule.refs].filter((reference) => live.has(reference)),
  );
  if (refs.size === rule.refs.size) return rule;
  return refs.size === 0 ? NO_RULE : { kind: rule.kind, refs };
}

type Refs = Pick<
  RepositorySnapshot,
  "head" | "branches" | "tags" | "worktrees"
>;

function soloTips(refs: Refs, soloed: ReadonlySet<FullRef>): Oid[] {
  return refs.branches
    .filter((branch) => soloed.has(branch.reference))
    .map((branch) => branch.oid);
}

function unhiddenTips(refs: Refs, hidden: ReadonlySet<FullRef>): Oid[] {
  return [
    ...refs.branches
      .filter((branch) => !hidden.has(branch.reference))
      .map((branch) => branch.oid),
    ...refs.tags.map((tag) => tag.oid),
    ...refs.worktrees.flatMap((worktree) =>
      worktree.head.kind === "unborn" ? [] : [worktree.head.oid],
    ),
  ];
}

export function visibleCommits<C extends Pick<Commit, "oid" | "parents">>(
  commits: readonly C[],
  refs: Refs,
  rule: VisibilityRule,
): readonly C[] {
  if (rule.kind === "none") return commits;
  const branchTips =
    rule.kind === "solo"
      ? soloTips(refs, rule.refs)
      : unhiddenTips(refs, rule.refs);
  const soloedBranchesAllGone = rule.kind === "solo" && branchTips.length === 0;
  if (soloedBranchesAllGone) return commits;
  const pending = refs.head.kind === "unborn" ? [] : [refs.head.oid];
  pending.push(...branchTips);
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
