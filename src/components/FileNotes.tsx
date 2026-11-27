import { useEffect } from "react";
import { ChevronDown, FileX2, TriangleAlert } from "lucide-react";
import { partialClone, pathLabel } from "../domain/filesChanged";
import type { RangeFile } from "../domain/range";
import {
  FileTotals,
  Moved,
  NoLongerChanged,
  StatusPill,
  ViewedBox,
} from "./FileParts";
import { ThreadsElsewhere } from "./ReviewThreads";
import { isElsewhere } from "./useFileItems";
import type { Unfolded } from "./ReviewThreads";
import type { FileEntry } from "./useFileItems";

export function FileHeader({
  entry: { file, part, parts },
  folded,
  isCurrent,
  isViewed,
  isSince,
  onFold,
  onMark,
}: {
  entry: FileEntry;
  folded: boolean;
  isCurrent: boolean;
  isViewed: boolean;
  /** Whether its lines are what changed since your review. */
  isSince: boolean;
  onFold: () => void;
  /** Null for a file the pull request no longer changes, which has no mark. */
  onMark: ((isViewed: boolean) => void) | null;
}) {
  const label = pathLabel(file);
  return (
    <div className="files-header">
      <button
        type="button"
        aria-expanded={!folded}
        aria-label={label}
        onClick={onFold}
      >
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      <span className="file-diff-path" title={label}>
        <bdi>{label}</bdi>
      </span>
      <StatusPill file={file} />
      {parts > 1 && (
        <span className="files-part">{part === 0 ? "Before" : "After"}</span>
      )}
      {part === 0 && <FileTotals file={file} isSince={isSince} />}
      {onMark === null ? (
        <NoLongerChanged />
      ) : (
        <ViewedBox
          name={`Viewed, ${label}`}
          isCurrent={isCurrent}
          isViewed={isViewed}
          onMark={onMark}
        />
      )}
    </div>
  );
}

/** Long enough for a file that the reader scrolls past. */
const NEAR_MS = 120;

/** Pierre draws it once it is near the view. */
function Reading({
  file,
  onRead,
}: {
  file: RangeFile;
  onRead: (file: RangeFile) => void;
}) {
  useEffect(() => {
    const timer = window.setTimeout(() => onRead(file), NEAR_MS);
    return () => window.clearTimeout(timer);
  }, [file, onRead]);
  return <p className="files-words">Reading this file…</p>;
}

function InPlaceOfLines({
  entry: { file, words, read },
  contentMissing,
  onRead,
  onReadAgain,
}: {
  entry: FileEntry;
  contentMissing: boolean;
  onRead: (file: RangeFile) => void;
  onReadAgain: (file: RangeFile) => void;
}) {
  if (contentMissing) return <p className="files-words">{partialClone}</p>;
  if (read?.kind === "failed")
    return (
      <div className="files-words" role="alert">
        <TriangleAlert size={14} aria-hidden="true" />
        <span>
          Couldn&apos;t read this file&apos;s changes. {read.problem.message}
        </span>
        <button
          type="button"
          className="button secondary"
          onClick={() => onReadAgain(file)}
        >
          Try again
        </button>
      </div>
    );
  if (words === null) return <Reading file={file} onRead={onRead} />;
  return (
    <p className="files-words">
      <FileX2 size={14} aria-hidden="true" />
      {words}
    </p>
  );
}

/** What there is to say about a file before its lines, or in place of them. */
export function OverLines({
  entry,
  contentMissing,
  viewer,
  url,
  unfolded,
  onRead,
  onReadAgain,
}: {
  entry: FileEntry;
  contentMissing: boolean;
  viewer: string;
  url: string;
  unfolded: Unfolded;
  onRead: (file: RangeFile) => void;
  onReadAgain: (file: RangeFile) => void;
}) {
  const { file, mode, lossy, elsewhere, diff } = entry;
  return (
    <div className="files-note">
      <Moved file={file} mode={mode} />
      {lossy && (
        <p className="files-moved">
          This file is not valid UTF-8. Bytes that are not UTF-8 appear as �, so
          some changed lines can look identical.
        </p>
      )}
      {isElsewhere(elsewhere) && (
        <ThreadsElsewhere
          path={file.path}
          elsewhere={elsewhere}
          viewer={viewer}
          url={url}
          unfolded={unfolded}
        />
      )}
      {diff === null && (
        <InPlaceOfLines
          entry={entry}
          contentMissing={contentMissing}
          onRead={onRead}
          onReadAgain={onReadAgain}
        />
      )}
    </div>
  );
}
