import type {
  FullRef,
  Oid,
  RepositoryRoot,
  RepositorySnapshot,
} from "./repository";

export type RefLabel =
  | {
      kind: "local";
      name: string;
      reference: FullRef;
      head: boolean;
      worktree: string | null;
    }
  | { kind: "remote"; name: string; reference: FullRef }
  | { kind: "tag"; name: string; reference: FullRef }
  | { kind: "worktree"; name: string; root: RepositoryRoot }
  | { kind: "head" };

function rank(label: RefLabel): number {
  switch (label.kind) {
    case "head":
      return 0;
    case "local":
      return label.head ? 0 : 1;
    case "worktree":
      return 2;
    case "remote":
      return 3;
    case "tag":
      return 4;
    default: {
      const exhaustive: never = label;
      return exhaustive;
    }
  }
}

const name = (label: RefLabel) => (label.kind === "head" ? "" : label.name);

export function refLabels(snapshot: RepositorySnapshot): Map<Oid, RefLabel[]> {
  const labels: { oid: Oid; label: RefLabel }[] = [];
  const checkedOutElsewhere = new Map<FullRef, string>();
  for (const worktree of snapshot.worktrees) {
    if (worktree.current) continue;
    switch (worktree.head.kind) {
      case "attached":
        checkedOutElsewhere.set(worktree.head.reference, worktree.name);
        break;
      case "detached":
        labels.push({
          oid: worktree.head.oid,
          label: { kind: "worktree", name: worktree.name, root: worktree.root },
        });
        break;
      case "unborn":
        break;
      default: {
        const exhaustive: never = worktree.head;
        return exhaustive;
      }
    }
  }
  if (snapshot.head.kind === "detached")
    labels.push({ oid: snapshot.head.oid, label: { kind: "head" } });
  const headReference =
    snapshot.head.kind === "attached" ? snapshot.head.reference : null;
  for (const branch of snapshot.branches)
    labels.push({
      oid: branch.oid,
      label:
        branch.kind === "local"
          ? {
              kind: "local",
              name: branch.name,
              reference: branch.reference,
              head: branch.reference === headReference,
              worktree: checkedOutElsewhere.get(branch.reference) ?? null,
            }
          : { kind: "remote", name: branch.name, reference: branch.reference },
    });
  for (const tag of snapshot.tags)
    labels.push({
      oid: tag.oid,
      label: { kind: "tag", name: tag.name, reference: tag.reference },
    });
  labels.sort(
    (a, b) =>
      rank(a.label) - rank(b.label) ||
      name(a.label).localeCompare(name(b.label)),
  );
  const byOid = new Map<Oid, RefLabel[]>();
  for (const { oid, label } of labels)
    byOid.set(oid, [...(byOid.get(oid) ?? []), label]);
  return byOid;
}
