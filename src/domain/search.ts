import type { Commit, Oid } from "./repository";

/** Folds text for case-insensitive search, so composed and decomposed accents match. */
export function foldCase(text: string): string {
  return text.normalize("NFC").toLocaleLowerCase();
}

type Searchable = Pick<Commit, "oid" | "subject" | "author" | "email">;

// Normalizing every commit on every keystroke costs about 9 ms on 50,000 commits.
const folded = new WeakMap<Searchable, string>();

function searchText(commit: Searchable): string {
  let text = folded.get(commit);
  if (text === undefined) {
    text = foldCase(`${commit.subject}\0${commit.author}\0${commit.email}`);
    folded.set(commit, text);
  }
  return text;
}

export function matchCommits(
  commits: readonly Searchable[],
  query: string,
): Oid[] {
  const needle = foldCase(query.trim());
  if (needle === "") return [];
  const matches: Oid[] = [];
  for (const commit of commits)
    if (commit.oid.startsWith(needle) || searchText(commit).includes(needle))
      matches.push(commit.oid);
  return matches;
}

/** Each match's place among the matches, in history order. */
export type MatchIndex = ReadonlyMap<Oid, number>;

export function indexMatches(matches: readonly Oid[]): MatchIndex {
  return new Map(matches.map((oid, index) => [oid, index]));
}

export function matchCount(
  query: string,
  matches: MatchIndex,
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

/**
 * The next match after `selected` in history order, or the previous one when
 * `by` is -1, wrapping around. With no selection it starts from the top.
 */
export function stepMatch(
  commits: readonly Pick<Commit, "oid">[],
  matches: MatchIndex,
  selected: Oid | null,
  by: 1 | -1,
): Oid | null {
  const count = commits.length;
  if (matches.size === 0 || count === 0) return null;
  const at =
    selected === null
      ? -1
      : commits.findIndex((commit) => commit.oid === selected);
  const from = at >= 0 ? at : by === 1 ? -1 : count;
  for (let step = 1; step <= count; step++) {
    const oid = commits[(((from + by * step) % count) + count) % count]?.oid;
    if (oid !== undefined && matches.has(oid)) return oid;
  }
  return null;
}
