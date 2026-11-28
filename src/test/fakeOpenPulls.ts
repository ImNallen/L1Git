import type { HostOpenPull, OpenPullContext, Opened } from "../domain/host";
import type { GitHubRepository } from "../domain/repository";

/** What the next opening answers. With none left, GitHub opens it, or
 * refuses it as a second one from the head into the base. `landed` says
 * whether GitHub opened one whose answer was lost. */
export type OpenScript =
  | { kind: "refused" | "notSent"; message: string }
  | { kind: "unknown"; landed: boolean };

/** A pull request GitHub has open, as opening one reads it. */
export type FakeOpen = { number: number; head: string; base: string };

type Host = {
  /** The open pull requests of each repository, by `owner/repo`. */
  opens: Map<string, FakeOpen[]>;
  openScript: OpenScript[];
  /** Every opening that reached GitHub, in order. */
  openings: HostOpenPull["open"][];
  ids: Map<string, string>;
};

const named = ({ owner, repo }: GitHubRepository) => `${owner}/${repo}`;

export const repositoryIdOf = (repository: GitHubRepository) =>
  `R_${repository.repo}`;

export function openContextHandler(
  { repository, head }: { repository: GitHubRepository; head: string },
  host: Host,
): OpenPullContext {
  return {
    repositoryId: host.ids.get(named(repository)) ?? repositoryIdOf(repository),
    defaultBranch: "main",
    open: (host.opens.get(named(repository)) ?? [])
      .filter((pull) => pull.head === head)
      .map(({ number, base }) => ({ number, base })),
  };
}

/** Looks first, as the host does, then opens it at most once. */
export function openPullHandler(
  { repository, open }: Pick<HostOpenPull, "repository" | "open">,
  host: Host,
): Opened {
  const name = named(repository);
  const opens = host.opens.get(name) ?? [];
  const found = () =>
    (host.opens.get(name) ?? []).find(
      (pull) => pull.head === open.head && pull.base === open.base,
    );
  const id = host.ids.get(name) ?? repositoryIdOf(repository);
  if (open.repositoryId !== id)
    return {
      kind: "notSent",
      message: `${name} is another repository on GitHub than the one L1 Git read, so it sent nothing. Open the pull request again.`,
    };
  const before = found();
  if (before) return { kind: "alreadyOpen", number: before.number };
  const script = host.openScript.shift();
  if (script?.kind === "notSent") return script;
  host.openings.push(open);
  const number = Math.max(40, ...opens.map((pull) => pull.number)) + 1;
  const opened = () =>
    host.opens.set(name, [
      ...opens,
      { number, head: open.head, base: open.base },
    ]);
  if (script?.kind === "refused") return script;
  if (script?.kind === "unknown") {
    if (script.landed) opened();
    return {
      kind: "unknown",
      message:
        "GitHub didn't answer in time, so the pull request may already be open. L1 Git looks for it on GitHub before it sends anything again.",
    };
  }
  opened();
  return { kind: "done", number };
}
