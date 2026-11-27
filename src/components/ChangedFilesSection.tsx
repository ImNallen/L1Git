import { useMemo } from "react";
import type { GitStatus } from "@pierre/trees";
import { distinctPaths, lineTotals, shownPath } from "../domain/filesChanged";
import type { PullRequest } from "../domain/pullRequest";
import { threadsLeftOut } from "../domain/pullRequestDetail";
import type { RangeFile } from "../domain/range";
import { commentsIn, threadsByFile } from "../domain/reviewThreads";
import { viewedCount as viewedOf } from "../domain/viewedFiles";
import {
  isSinceShown,
  shownFiles,
  sinceShown,
  sinceTotal,
} from "../filesChanged";
import type { FilesChanged } from "../filesChanged";
import { ChangedFileTree } from "./ChangedFileTree";
import type { RowLabel } from "./ChangedFileTree";
import { LineTotals } from "./LineTotals";
import { Bars, OnGitHub } from "./PullRequestParts";

const gitStatuses: Record<RangeFile["status"], GitStatus> = {
  A: "added",
  D: "deleted",
  M: "modified",
  R: "renamed",
  T: "modified",
};

function Tree({
  files,
  at,
  viewed,
  threads,
  onGo,
}: {
  files: readonly RangeFile[];
  at: number;
  viewed: ReadonlySet<RangeFile>;
  threads: PullRequest["threads"];
  onGo: (at: number) => void;
}) {
  const named = useMemo(
    () =>
      distinctPaths(files).map(({ path, status }) => ({
        path: shownPath(path),
        status,
      })),
    [files],
  );
  const labels = useMemo(
    () =>
      new Map(
        named.flatMap(({ path, status }): [string, RowLabel][] =>
          status === "T" ? [[path, { text: "T", tone: "warning" }]] : [],
        ),
      ),
    [named],
  );
  const selected = files[at];
  const comments = useMemo(
    () =>
      new Map(
        [...threadsByFile(files, threads?.items ?? [])].map(([file, own]) => [
          shownPath(file.path),
          commentsIn(own),
        ]),
      ),
    [files, threads],
  );
  const choose = (path: string) =>
    onGo(files.findIndex((file) => shownPath(file.path) === path));
  const viewedPaths = useMemo(
    () => new Set([...viewed].map(({ path }) => shownPath(path))),
    [viewed],
  );
  const viewedCount = files.filter((file) => viewed.has(file)).length;
  return (
    <ChangedFileTree
      files={named.map(({ path, status }) => ({
        path,
        status: gitStatuses[status],
      }))}
      labels={labels}
      comments={comments}
      viewed={viewedPaths}
      overTree={
        <div className="files-progress">
          <span>Viewed</span>
          <span>{viewedOf(viewedCount, files.length)}</span>
          <progress aria-hidden="true" value={viewedCount} max={files.length} />
        </div>
      }
      selectedPath={selected ? shownPath(selected.path) : null}
      onSelectFile={choose}
      onSelectAgain={choose}
    />
  );
}

/** The files of the Files changed tab. `held` is null until they were asked for. */
export function ChangedFilesSection({
  held,
  viewed,
  pull,
  url,
  onGo,
}: {
  held: FilesChanged | null;
  viewed: ReadonlySet<RangeFile>;
  pull: PullRequest | null;
  url: string;
  onGo: (at: number) => void;
}) {
  const of = held?.pull ?? pull;
  const read = held?.read.kind === "ready" ? held.read : null;
  const shown = held ? shownFiles(held) : [];
  const isSince = held !== null && isSinceShown(held);
  const since = held && isSince ? sinceShown(held) : null;
  const isReading =
    held === null ||
    held.read.kind === "reading" ||
    held.read.kind === "fetching" ||
    (isSince &&
      (held.since?.read.kind === "reading" ||
        held.since?.read.kind === "fetching"));
  const totals =
    read && !read.contentMissing
      ? lineTotals(isSince ? shown : read.files)
      : of && { added: of.additions, deleted: of.deletions };
  const threads =
    of === null
      ? null
      : of.threads === null
        ? "Review threads didn't load."
        : threadsLeftOut(of);
  return (
    <section className="files-section" aria-label="Changed files">
      <h3>
        {isSince ? (
          <span className="changed-files-title">
            Since your last review
            {read && since && (
              <span className="count">
                {since.again.length.toLocaleString()} of{" "}
                {sinceTotal(since).toLocaleString()}
              </span>
            )}
          </span>
        ) : (
          <span className="changed-files-title">
            Changed files
            {of && (
              <span className="count">
                {(read?.files.length ?? of.changedFiles).toLocaleString()}
              </span>
            )}
          </span>
        )}
        {totals && <LineTotals {...totals} />}
      </h3>
      {threads !== null && (
        <p className="pull-inspector-none">
          {threads} <OnGitHub url={url} />
        </p>
      )}
      {shown.length > 0 ? (
        <Tree
          key={`${read?.mergeBase} ${held?.range.head} ${isSince ? `since ${held.since?.rebased}` : "all"}`}
          files={shown}
          at={held?.at ?? 0}
          viewed={viewed}
          threads={held?.pull.threads ?? null}
          onGo={onGo}
        />
      ) : (
        isReading && <Bars count={4} />
      )}
    </section>
  );
}
