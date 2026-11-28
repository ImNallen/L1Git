type Feature = { title: string; pullNumber: string | null };
type Counts = { fixes: number; docs: number; other: number };

export type Changelog =
  | ({ kind: "changes"; since: string | null; features: Feature[] } & Counts)
  | { kind: "text"; text: string };

const groups = new Map<string, "feature" | keyof Counts>([
  ["feat", "feature"],
  ["fix", "fixes"],
  ["docs", "docs"],
]);
const conventional = /^(\w+)(?:\([^)]*\))?!?:\s*/;

function entry(subject: string): Feature {
  const reference =
    / by @[\w-]+ in https:\/\/github\.com\/ImNallen\/L1Git\/pull\/([1-9]\d*)$/.exec(
      subject,
    ) ?? / \(#([1-9]\d*)\)$/.exec(subject);
  return {
    title: reference ? subject.slice(0, reference.index) : subject,
    pullNumber: reference?.[1] ?? null,
  };
}

function summarize(entries: Feature[], since: string | null): Changelog {
  const features: Feature[] = [];
  const counts: Counts = { fixes: 0, docs: 0, other: 0 };
  const seen = new Set<string>();
  for (const { title, pullNumber } of entries) {
    if (pullNumber !== null) {
      if (seen.has(pullNumber)) continue;
      seen.add(pullNumber);
    }
    const prefix = conventional.exec(title);
    const group = groups.get(prefix?.[1]?.toLowerCase() ?? "") ?? "other";
    const rest = title.slice(prefix?.[0].length ?? 0).trim();
    if (group === "feature" && rest)
      features.push({
        title: rest.charAt(0).toUpperCase() + rest.slice(1),
        pullNumber,
      });
    else counts[group === "feature" ? "other" : group] += 1;
  }
  return { kind: "changes", since, features, ...counts };
}

export function changelog(
  { changes, notes }: { changes: string[] | null; notes: string | null },
  installedVersion: string,
): Changelog | null {
  if (changes?.length) return summarize(changes.map(entry), installedVersion);
  if (!notes?.trim()) return null;
  const lines = notes.trim().split(/\r?\n/);
  if (lines[0] === "## What's Changed") lines.shift();
  const entries = lines
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => entry(line.replace(/^[*-] /, "")));
  return entries.length &&
    entries.every(({ title }) => title && !/[<>`\[\]#*]|:\/\//.test(title)) &&
    entries.some(({ title }) => conventional.test(title))
    ? summarize(entries, null)
    : { kind: "text", text: notes };
}

const nouns: Record<keyof Counts, [string, string]> = {
  fixes: ["fix", "fixes"],
  docs: ["doc update", "doc updates"],
  other: ["other change", "other changes"],
};

export function countsPhrase(counts: Counts): string | null {
  const parts = (["fixes", "docs", "other"] as const)
    .filter((group) => counts[group] > 0)
    .map(
      (group) =>
        `${counts[group]} ${nouns[group][counts[group] === 1 ? 0 : 1]}`,
    );
  const last = parts.pop();
  if (last === undefined) return null;
  return parts.length ? `${parts.join(", ")} and ${last}` : last;
}
