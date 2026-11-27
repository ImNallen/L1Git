import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
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
import type { FilesChanged, Since, SinceShown } from "../filesChanged";
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

/** A folded group's tree has no filter of its own, and scrolls past this many rows. */
const MOST_GROUP_ROWS = 40;

function Tree({
  files,
  at,
  viewed,
  progressOf = files,
  maxRows,
  threads,
  onGo,
}: {
  files: readonly RangeFile[];
  at: number;
  viewed: ReadonlySet<RangeFile>;
  /** The files the viewed count is of, or null for none. */
  progressOf?: readonly RangeFile[] | null;
  maxRows?: number;
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
  const viewedCount =
    progressOf?.filter((file) => viewed.has(file)).length ?? 0;
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
        progressOf && (
          <div className="files-progress">
            <span>Viewed</span>
            <span>{viewedOf(viewedCount, progressOf.length)}</span>
            <progress
              aria-hidden="true"
              value={viewedCount}
              max={progressOf.length}
            />
          </div>
        )
      }
      maxRows={maxRows}
      selectedPath={selected ? shownPath(selected.path) : null}
      onSelectFile={choose}
      onSelectAgain={choose}
    />
  );
}

/** A folded group of files, and its count. */
function GroupRow({
  label,
  count,
  isOpen,
  onToggle,
}: {
  label: string;
  count: number;
  isOpen: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="since-group"
      aria-expanded={isOpen}
      onClick={onToggle}
    >
      <ChevronDown size={14} aria-hidden="true" />
      <span>{label}</span>
      <span className="since-group-count">{count.toLocaleString()}</span>
    </button>
  );
}

/**
 * What the author changed since your review, and below it the files that
 * didn't change since then and the ones only the base's changes moved, each
 * folded into a row.
 */
function SinceGroups({
  held,
  since,
  viewed,
  onGo,
  onShowRebased,
  onOpenInAll,
}: {
  held: FilesChanged;
  since: SinceShown;
  viewed: ReadonlySet<RangeFile>;
  onGo: (at: number) => void;
  onShowRebased: (rebased: Since["rebased"]) => void;
  onOpenInAll: (file: RangeFile) => void;
}) {
  const [isUnchangedOpen, setUnchangedOpen] = useState(false);
  const { again, rebased, unchanged } = since;
  const isRebasedShown = held.since?.rebased === "shown";
  const threads = held.pull.threads;
  const key = `${held.range.head} ${held.since?.rebased}`;
  return (
    <>
      {again.length > 0 && (
        <Tree
          key={`again ${key}`}
          files={again}
          at={held.at}
          viewed={viewed}
          progressOf={shownFiles(held)}
          threads={threads}
          onGo={onGo}
        />
      )}
      {unchanged.length > 0 && (
        <GroupRow
          label="Unchanged since your review"
          count={unchanged.length}
          isOpen={isUnchangedOpen}
          onToggle={() => setUnchangedOpen((before) => !before)}
        />
      )}
      {isUnchangedOpen && unchanged.length > 0 && (
        <Tree
          key={`unchanged ${key}`}
          files={unchanged}
          at={-1}
          viewed={viewed}
          progressOf={null}
          maxRows={MOST_GROUP_ROWS}
          threads={threads}
          onGo={(at) => {
            const file = unchanged[at];
            if (file) onOpenInAll(file);
          }}
        />
      )}
      {rebased.length > 0 && (
        <GroupRow
          label="Changed only by the rebase"
          count={rebased.length}
          isOpen={isRebasedShown}
          onToggle={() => onShowRebased(isRebasedShown ? "folded" : "shown")}
        />
      )}
      {isRebasedShown && rebased.length > 0 && (
        <Tree
          key={`rebased ${key}`}
          files={rebased}
          at={held.at - again.length}
          viewed={viewed}
          progressOf={null}
          maxRows={MOST_GROUP_ROWS}
          threads={threads}
          onGo={(at) => onGo(again.length + at)}
        />
      )}
    </>
  );
}

/** The files of the Files changed tab. `held` is null until they were asked for. */
export function ChangedFilesSection({
  held,
  viewed,
  pull,
  url,
  onGo,
  onShowRebased,
  onOpenInAll,
}: {
  held: FilesChanged | null;
  viewed: ReadonlySet<RangeFile>;
  pull: PullRequest | null;
  url: string;
  onGo: (at: number) => void;
  onShowRebased: (rebased: Since["rebased"]) => void;
  /** Shows All changes at a file. */
  onOpenInAll: (file: RangeFile) => void;
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
      {held && since ? (
        <SinceGroups
          held={held}
          since={since}
          viewed={viewed}
          onGo={onGo}
          onShowRebased={onShowRebased}
          onOpenInAll={onOpenInAll}
        />
      ) : shown.length > 0 ? (
        <Tree
          key={`${read?.mergeBase} ${held?.range.head}`}
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
