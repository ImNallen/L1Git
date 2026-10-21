import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { FileX2, LoaderCircle, TriangleAlert } from "lucide-react";
import { File, Virtualizer } from "@pierre/diffs/react";
import type { LineAnnotation } from "@pierre/diffs/react";
import * as repositories from "../repositories";
import { singleCommit } from "../domain/comparison";
import { SHORT_OID_MIN_LENGTH } from "../domain/shortOid";
import { relativeTime } from "../domain/time";
import { clampMessage } from "../domain/worktree";
import type {
  BlameRange,
  FileRevision,
  Oid,
  Problem,
  RepositoryRoot,
} from "../domain/repository";
import { diffTheme } from "../themes/diffTheme";
import type { Appearance } from "../themes/palette";
import { useRead } from "../useRead";
import type { Read } from "../useRead";
import { Diff } from "./FilePatchView";
import type { DiffStyle } from "./FilePatchView";

/** A file as it is in one commit. */
export type Revision = { root: RepositoryRoot; oid: Oid; path: string };

type Look = { diffStyle: DiffStyle; theme: Appearance; painted: boolean };

const short = (oid: Oid) => oid.slice(0, SHORT_OID_MIN_LENGTH);
/** Keys that move the history list read a diff only once the row stays this long. */
const SETTLE_MS = 150;

export function FileHistory({
  revision,
  ...look
}: { revision: Revision } & Look) {
  const { root, oid, path } = revision;
  const [history, retry] = useRead(JSON.stringify([root, oid, path]), () =>
    repositories.fileHistory(root, oid, path),
  );
  if (history.kind !== "ready")
    return <Pending read={history} what="history" onRetry={retry} />;
  const [newest] = history.value;
  if (newest === undefined)
    return (
      <div className="file-diff-empty">
        <p>No commits changed this file.</p>
      </div>
    );
  return (
    <RevisionList
      key={JSON.stringify([root, oid, path])}
      root={root}
      newest={newest}
      revisions={history.value}
      {...look}
    />
  );
}

function RevisionList({
  root,
  newest,
  revisions,
  ...look
}: {
  root: RepositoryRoot;
  newest: FileRevision;
  revisions: FileRevision[];
} & Look) {
  const [index, setIndex] = useState(0);
  const [settled, setSettled] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const chosen = revisions[settled] ?? newest;
  useEffect(() => {
    list.current
      ?.querySelector(`[data-index="${index}"]`)
      ?.scrollIntoView({ block: "nearest" });
    if (index === settled) return;
    const settle = setTimeout(() => setSettled(index), SETTLE_MS);
    return () => clearTimeout(settle);
  }, [index, settled]);
  const move = (event: KeyboardEvent) => {
    const next =
      event.key === "ArrowDown"
        ? index + 1
        : event.key === "ArrowUp"
          ? index - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? revisions.length - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    setIndex(Math.max(0, Math.min(revisions.length - 1, next)));
  };
  const now = Date.now() / 1000;
  return (
    <div className="file-history">
      <div
        ref={list}
        className="file-history-list"
        role="listbox"
        aria-label="Commits that changed this file"
        aria-activedescendant={`file-revision-${index}`}
        tabIndex={0}
        onKeyDown={move}
      >
        {revisions.map(({ commit, path }, at) => (
          <div
            key={commit.oid}
            id={`file-revision-${at}`}
            data-index={at}
            role="option"
            aria-selected={at === index}
            className="file-revision"
            onClick={() => {
              setIndex(at);
              setSettled(at);
            }}
          >
            <span className="file-revision-oid">{short(commit.oid)}</span>
            <span className="file-revision-subject" title={commit.subject}>
              {commit.subject}
            </span>
            {path !== newest.path && (
              <span className="file-revision-path" title={path}>
                {path}
              </span>
            )}
            <span className="file-revision-author">{commit.author}</span>
            <span className="file-revision-age">
              {relativeTime(commit.timestamp, now)}
            </span>
          </div>
        ))}
      </div>
      <RevisionDiff
        key={chosen.commit.oid}
        revision={{ root, oid: chosen.commit.oid, path: chosen.path }}
        {...look}
      />
    </div>
  );
}

function RevisionDiff({ revision, ...look }: { revision: Revision } & Look) {
  const { root, oid, path } = revision;
  const [patch, retry] = useRead(JSON.stringify([root, oid, path]), () =>
    repositories.filePatch(root, singleCommit(oid), path),
  );
  if (patch.kind !== "ready")
    return <Pending read={patch} what="changes" onRetry={retry} />;
  return <Diff diff={patch.value} {...look} />;
}

export function FileBlame({
  revision,
  theme,
  painted,
  selectable,
  onSelectCommit,
}: {
  revision: Revision;
  theme: Appearance;
  painted: boolean;
  selectable: (oid: Oid) => boolean;
  onSelectCommit: (oid: Oid) => void;
}) {
  const { root, oid, path } = revision;
  const [blame, retry] = useRead(JSON.stringify([root, oid, path]), () =>
    repositories.blame(root, oid, path),
  );
  const ready = blame.kind === "ready" ? blame.value : null;
  const ranges = ready?.kind === "text" ? ready.ranges : null;
  const annotations = useMemo(
    () =>
      ranges?.map(
        (range): LineAnnotation<BlameRange> => ({
          lineNumber: range.start - 1,
          metadata: range,
        }),
      ) ?? [],
    [ranges],
  );
  const options = useMemo(
    () => ({
      theme: diffTheme(theme, painted),
      themeType: theme,
      disableFileHeader: true,
      onLineNumberClick: ({ lineNumber }: { lineNumber: number }) => {
        const range = ranges?.find(
          (range) =>
            range.start <= lineNumber && lineNumber < range.start + range.lines,
        );
        if (range && selectable(range.oid)) onSelectCommit(range.oid);
      },
    }),
    [theme, painted, ranges, selectable, onSelectCommit],
  );
  if (blame.kind !== "ready")
    return <Pending read={blame} what="blame" onRetry={retry} />;
  const value = blame.value;
  if (value.kind !== "text")
    return (
      <div className="file-diff-empty">
        <FileX2 size={28} />
        <p>
          {value.kind === "binary"
            ? "Binary file. L1 Git does not blame binary files."
            : `This file is ${(value.bytes / 1024 / 1024).toFixed(1)} MiB, above the 1 MiB display limit.`}
        </p>
      </div>
    );
  if (value.contents === "")
    return (
      <div className="file-diff-empty">
        <p>This file is empty in this commit, so it has no lines to blame.</p>
      </div>
    );
  const now = Date.now() / 1000;
  return (
    <>
      {value.lossy && (
        <div className="notice error-notice" role="status">
          <TriangleAlert size={14} />
          <span>
            This file is not valid UTF-8. Bytes that are not UTF-8 appear as �.
          </span>
        </div>
      )}
      <Virtualizer className="file-diff-scroll file-blame">
        <File
          file={{
            name: path,
            contents: value.contents.replace(/\n$/, ""),
            cacheKey: oid + path,
          }}
          options={options}
          lineAnnotations={annotations}
          renderAnnotation={({ metadata: range }) => (
            <BlameEntry
              range={range}
              now={now}
              selectable={selectable(range.oid)}
              onSelect={() => onSelectCommit(range.oid)}
            />
          )}
        />
      </Virtualizer>
    </>
  );
}

function BlameEntry({
  range,
  now,
  selectable,
  onSelect,
}: {
  range: BlameRange;
  now: number;
  selectable: boolean;
  onSelect: () => void;
}) {
  const age = relativeTime(range.timestamp, now);
  const label = `${range.author}, ${age}, ${short(range.oid)} ${range.summary}`;
  return (
    <button
      className="blame-entry"
      disabled={!selectable}
      onClick={onSelect}
      aria-label={
        selectable
          ? `Select ${label} in the graph`
          : `${label}. This commit is hidden or not loaded in the graph.`
      }
      title={
        selectable
          ? `Select ${short(range.oid)} in the graph`
          : "This commit is hidden or not loaded in the graph."
      }
    >
      <span className="blame-author">{range.author}</span>
      <span className="blame-age">{age}</span>
      <span className="blame-oid">{short(range.oid)}</span>
      <span className="blame-summary">{range.summary}</span>
    </button>
  );
}

function Pending({
  read,
  what,
  onRetry,
}: {
  read: Exclude<Read<unknown>, { kind: "ready" }>;
  what: string;
  onRetry: () => void;
}) {
  if (read.kind === "loading")
    return (
      <div className="file-diff-empty" role="status">
        <LoaderCircle size={23} className="spin" />
        <p>Reading this file's {what}…</p>
      </div>
    );
  return <ReadProblem error={read.error} onRetry={onRetry} />;
}

function ReadProblem({
  error,
  onRetry,
}: {
  error: Problem;
  onRetry: () => void;
}) {
  return (
    <div className="file-diff-empty">
      {error.kind === "gitFailed" ? (
        <pre className="problem-detail" role="alert">
          {clampMessage(error.message)}
        </pre>
      ) : (
        <p role="alert">{error.message}</p>
      )}
      {error.kind !== "unsupportedPath" && (
        <button className="button secondary" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}
