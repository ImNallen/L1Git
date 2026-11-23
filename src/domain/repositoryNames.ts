import type { RepositoryRoot } from "./repository";

type Named = { root: RepositoryRoot; name: string };

function parentTails(root: RepositoryRoot): string[] {
  const parent = root.replace(/[\\/]+[^\\/]+[\\/]*$/, "");
  const tails = [...parent.matchAll(/[^\\/]+/g)]
    .map((match) => parent.slice(match.index))
    .reverse();
  const whole = parent || root.charAt(0);
  return tails.at(-1) === whole ? tails : [...tails, whole];
}

export function distinctNames(
  entries: readonly Named[],
): ReadonlyMap<RepositoryRoot, string> {
  const groups = new Map<string, Named[]>();
  for (const entry of entries)
    groups.set(entry.name, [...(groups.get(entry.name) ?? []), entry]);
  const suffixes = new Map<RepositoryRoot, string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const tails = group.map((entry) => parentTails(entry.root));
    const at = (depth: number) =>
      tails.map((own) => own[Math.min(depth, own.length) - 1]!);
    const deepest = Math.max(...tails.map((own) => own.length));
    let depth = 1;
    while (depth < deepest && new Set(at(depth)).size < group.length)
      depth += 1;
    at(depth).forEach((tail, index) => suffixes.set(group[index]!.root, tail));
  }
  return suffixes;
}
