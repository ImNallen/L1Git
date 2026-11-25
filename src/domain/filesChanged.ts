import { changedFileTreeInput, treePath } from "./changedFiles";
import { undrawn } from "./fileSides";
import { fetchFailureLabels } from "./overview";
import type { PullRequest, TimelineEvent } from "./pullRequest";
import { counted, personName } from "./pullRequestDetail";
import type { ListedRepository } from "./pullRequestList";
import type { CommitsFetch, RangeFile } from "./range";
import type { FilePatch, GitHubRepository, Oid, Problem } from "./repository";
import { shortOid } from "./shortOid";

/** What a pull request changes: what came to `head` since it forked from `baseOid`. */
export type Range = {
  repository: ListedRepository;
  base: string;
  baseOid: Oid;
  head: Oid;
};

export const rangeOf = (
  repository: ListedRepository,
  { base, baseOid, head }: Pick<PullRequest, "base" | "baseOid" | "head">,
): Range => ({ repository, base, baseOid, head: head.oid });

/** Null when a person can't be told. */
function pushed(
  { timeline }: Pick<PullRequest, "timeline">,
  head: Oid,
): string | null {
  const to = (event: TimelineEvent) =>
    (event.kind === "commit" && event.oid === head) ||
    (event.kind === "forcePushed" && event.to === head);
  return timeline.items.findLast(to)?.by ?? null;
}

/** What a newer read has that the range shown has not. */
export function newerThan(
  range: Pick<Range, "base" | "head">,
  pull: Pick<PullRequest, "base" | "head" | "timeline">,
  viewer: string,
): { text: string; show: string } | null {
  const by = pushed(pull, pull.head.oid);
  const commits =
    by === null
      ? "New commits were pushed"
      : `${personName(by, viewer)} pushed new commits`;
  const isPushed = pull.head.oid !== range.head;
  if (pull.base === range.base)
    return isPushed ? { text: `${commits}.`, show: "Show them" } : null;
  return isPushed
    ? {
        text: `${commits}, and the base changed to ${pull.base}.`,
        show: "Show them",
      }
    : { text: `The base changed to ${pull.base}.`, show: "Show it" };
}

/** Why there is nothing to show. */
export type Stop =
  | { kind: "unrelated"; shallow: boolean }
  | { kind: "treesMissing" }
  | { kind: "stillMissing" }
  | Exclude<CommitsFetch, { kind: "done" }>
  | { kind: "unreadable"; problem: Problem };

const partialClone =
  "This is a partial clone, and file contents aren't on this computer.";

export function stopText(
  stop: Stop,
  { owner, repo }: GitHubRepository,
): {
  title: string;
  detail: string | null;
  /** Whether the detail is Git's own words. */
  verbatim: boolean;
  /** Whether another try may end otherwise. */
  retry: boolean;
} {
  const getting = { title: "Couldn't get the commits", retry: true };
  switch (stop.kind) {
    case "unrelated":
      return stop.shallow
        ? {
            title: "Couldn't find where this pull request starts",
            detail:
              "This is a shallow clone, and the commit where this pull request starts isn't in it.",
            verbatim: false,
            retry: true,
          }
        : {
            title: "Nothing to compare",
            detail: "This pull request and its base have no commit in common.",
            verbatim: false,
            retry: false,
          };
    case "treesMissing":
      return {
        title: partialClone,
        detail: null,
        verbatim: false,
        retry: false,
      };
    case "stillMissing":
      return {
        ...getting,
        detail: "GitHub answered, but the commits still aren't in this clone.",
        verbatim: false,
      };
    case "noRemote":
      return {
        ...getting,
        detail: `This clone has no remote for ${owner}/${repo}.`,
        verbatim: false,
      };
    case "failed":
      return {
        ...getting,
        detail: `${fetchFailureLabels[stop.failure]}. ${stop.message}`,
        verbatim: false,
      };
    case "unreadable":
      return {
        title: "Couldn't read the changes",
        detail: stop.problem.message,
        verbatim: stop.problem.kind === "gitFailed",
        retry: true,
      };
    default: {
      const exhaustive: never = stop;
      return exhaustive;
    }
  }
}

/** The order of the tree, so that a step to the next file is a step down it. */
export function inTreeOrder(files: readonly RangeFile[]): RangeFile[] {
  const place = new Map(
    changedFileTreeInput(files).paths.map((path, at) => [path, at]),
  );
  const placeOf = ({ path }: RangeFile) => place.get(treePath(path)) ?? 0;
  return [...files].sort((left, right) => placeOf(left) - placeOf(right));
}

/** One file for each name, as a tree needs. Names of bytes that are no text can look the same. */
export const distinctPaths = (files: readonly RangeFile[]) => [
  ...new Map(files.map((file) => [file.path, file])).values(),
];

/** Binary files have no lines. */
export const lineTotals = (files: readonly RangeFile[]) => ({
  added: files.reduce((sum, { added }) => sum + (added ?? 0), 0),
  deleted: files.reduce((sum, { deleted }) => sum + (deleted ?? 0), 0),
});

type Counts = Pick<PullRequest, "changedFiles" | "additions" | "deletions">;

/** An edited rename is a deletion and an addition when no contents were read. */
const unpaired = (files: readonly RangeFile[]) =>
  Math.min(
    files.filter(({ status }) => status === "A").length,
    files.filter(({ status }) => status === "D").length,
  );

/** How what was read here is not what GitHub counts, or null when it is. */
export function countsNotice(
  {
    files,
    contentMissing,
  }: { files: readonly RangeFile[]; contentMissing: boolean },
  github: Counts,
): string | null {
  const here = { ...lineTotals(files), changedFiles: files.length };
  const most = contentMissing ? unpaired(files) : 0;
  const more = here.changedFiles - github.changedFiles;
  const sameLines =
    contentMissing ||
    (here.added === github.additions && here.deleted === github.deletions);
  if (more >= 0 && more <= most && sameLines) return null;
  const words = (changedFiles: number, added: number, deleted: number) =>
    contentMissing
      ? counted(changedFiles, "file")
      : `${counted(changedFiles, "file")}, +${added.toLocaleString()} −${deleted.toLocaleString()}`;
  const { changedFiles, additions, deletions } = github;
  return `GitHub counts ${words(changedFiles, additions, deletions)}. This shows ${words(here.changedFiles, here.added, here.deleted)}.`;
}

/** "src/{ → replay}/Panel.tsx". */
export function pathLabel({
  path,
  from,
}: Pick<RangeFile, "path" | "from">): string {
  if (from === null) return path;
  const old = from.split("/");
  const now = path.split("/");
  const most = Math.min(old.length, now.length);
  let start = 0;
  while (start < most - 1 && old[start] === now[start]) start += 1;
  let end = 0;
  while (end < most - start && old.at(-1 - end) === now.at(-1 - end)) end += 1;
  const middle = (parts: string[]) =>
    parts.slice(start, parts.length - end).join("/");
  const change = `${middle(old)} → ${middle(now)}`;
  if (start === 0 && end === 0) return change;
  return [
    ...now.slice(0, start),
    `{${change}}`,
    ...now.slice(now.length - end),
  ].join("/");
}

export type StatusWord = {
  word: string;
  tone: "added" | "deleted" | "moved" | "other";
};

/** Null for a file whose contents changed and nothing else. */
export function statusWord({
  status,
  submodule,
  oldBlob,
  newBlob,
}: Pick<
  RangeFile,
  "status" | "submodule" | "oldBlob" | "newBlob"
>): StatusWord | null {
  switch (status) {
    case "A":
      return { word: "Added", tone: "added" };
    case "D":
      return { word: "Deleted", tone: "deleted" };
    case "R":
      return { word: "Renamed", tone: "moved" };
    case "T":
      return { word: "Type changed", tone: "other" };
    case "M":
      if (oldBlob === newBlob) return { word: "Mode changed", tone: "other" };
      return submodule ? { word: "Submodule", tone: "other" } : null;
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

const modes = (patch: string) =>
  /^old mode (\d+)\nnew mode (\d+)$/m.exec(patch);

function modeWords(patch: string): string | null {
  const [, before, after] = modes(patch) ?? [];
  if (before === undefined) return null;
  if (before === "100644" && after === "100755")
    return "The file was made executable.";
  if (before === "100755" && after === "100644")
    return "The file is no longer executable.";
  return `The file mode changed from ${before} to ${after}.`;
}

function submoduleWords({
  status,
  oldBlob,
  newBlob,
}: RangeFile): string | null {
  const at = (oid: Oid | null) => (oid === null ? "" : shortOid(oid));
  switch (status) {
    case "A":
      return `This submodule was added at ${at(newBlob)}.`;
    case "D":
      return `This submodule was removed. It was at ${at(oldBlob)}.`;
    case "M":
      return `This submodule moved from ${at(oldBlob)} to ${at(newBlob)}. L1 Git does not show the changes inside it.`;
    case "R":
      return oldBlob === newBlob
        ? null
        : `This submodule was renamed, and moved from ${at(oldBlob)} to ${at(newBlob)}.`;
    case "T":
      return null;
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

/** Every line of a hunk begins with a space, a sign, or a backslash. */
const hasLines = (patch: string) => /^@@ /m.test(patch);

/** What a file says in place of lines, or null when it has lines to draw. */
export function inPlaceOfLines(
  file: RangeFile,
  patch: FilePatch,
): string | null {
  const submodule = file.submodule ? submoduleWords(file) : null;
  if (submodule !== null) return submodule;
  if (patch.kind !== "text") return undrawn(patch);
  if (hasLines(patch.patch)) return null;
  const mode = modeWords(patch.patch);
  switch (file.status) {
    case "A":
      return "This file was added empty.";
    case "D":
      return "This file was empty when it was deleted.";
    case "R":
      return mode === null
        ? "Renamed without changes."
        : `Renamed. ${mode} Its contents did not change.`;
    default:
      return mode === null
        ? "Its contents did not change."
        : `${mode} Its contents did not change.`;
  }
}
