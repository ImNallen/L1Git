import type { Commit, Oid } from "./repository";

/**
 * The loaded commits that match `query`, in history order. A commit matches when
 * its subject, author name, or email contains the query, ignoring case, or when
 * its ID starts with it.
 */
export function matchCommits(
  commits: readonly Pick<Commit, "oid" | "subject" | "author" | "email">[],
  query: string,
): Oid[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [];
  const matches: Oid[] = [];
  for (const commit of commits)
    if (
      commit.oid.startsWith(needle) ||
      commit.subject.toLowerCase().includes(needle) ||
      commit.author.toLowerCase().includes(needle) ||
      commit.email.toLowerCase().includes(needle)
    )
      matches.push(commit.oid);
  return matches;
}
