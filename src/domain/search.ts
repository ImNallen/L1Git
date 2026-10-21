import type { Commit, Oid } from "./repository";

export function normalizeSearch(text: string): string {
  return text.normalize("NFC").toLocaleLowerCase();
}

type Searchable = Pick<Commit, "oid" | "subject" | "author" | "email">;

const folded = new WeakMap<Searchable, string>();

function searchText(commit: Searchable): string {
  let text = folded.get(commit);
  if (text === undefined) {
    text = normalizeSearch(
      `${commit.subject}\0${commit.author}\0${commit.email}`,
    );
    folded.set(commit, text);
  }
  return text;
}

export function matchCommits(
  commits: readonly Searchable[],
  query: string,
): Oid[] {
  const needle = normalizeSearch(query.trim());
  if (needle === "") return [];
  const matches: Oid[] = [];
  for (const commit of commits)
    if (commit.oid.startsWith(needle) || searchText(commit).includes(needle))
      matches.push(commit.oid);
  return matches;
}

export type MatchPositions = ReadonlyMap<Oid, number>;

export function matchPositions(matches: readonly Oid[]): MatchPositions {
  return new Map(matches.map((oid, index) => [oid, index]));
}

export function matchCount(
  query: string,
  matches: MatchPositions,
  selected: Oid | null,
): string {
  if (query.trim() === "") return "";
  const total = matches.size;
  if (total === 0) return "No matches";
  const at = selected === null ? undefined : matches.get(selected);
  if (at === undefined)
    return `${total.toLocaleString()} ${total === 1 ? "match" : "matches"}`;
  return `${(at + 1).toLocaleString()} of ${total.toLocaleString()}`;
}

export function stepMatch(
  commits: readonly Pick<Commit, "oid">[],
  matches: MatchPositions,
  selected: Oid | null,
  by: 1 | -1,
): Oid | null {
  const count = commits.length;
  if (matches.size === 0 || count === 0) return null;
  const selectedRow =
    selected === null
      ? -1
      : commits.findIndex((commit) => commit.oid === selected);
  const start = selectedRow >= 0 ? selectedRow : by === 1 ? -1 : count;
  for (let step = 1; step <= count; step++) {
    const oid = commits[(start + by * step + count) % count]?.oid;
    if (oid !== undefined && matches.has(oid)) return oid;
  }
  return null;
}
