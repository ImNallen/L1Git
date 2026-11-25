import { useCallback, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import {
  newerThan,
  pathLabel,
  statusWord,
  stopText,
} from "../domain/filesChanged";
import type { Stop } from "../domain/filesChanged";
import type { DiffStyle } from "../domain/lineSelection";
import type { PullRequest, ReviewThread } from "../domain/pullRequest";
import type { RangeFile } from "../domain/range";
import { threadsByFile } from "../domain/reviewThreads";
import { clampMessage } from "../domain/worktree";
import type { FilesChanged as Held } from "../filesChanged";
import type { FilesChangedState } from "../shell/useFilesChanged";
import { FileChanged } from "./FileChanged";
import type { Unfolded } from "./FileChanged";
import { FilesState, ReadingFiles } from "./FilesState";
import { LineTotals } from "./LineTotals";

const styles: { style: DiffStyle; label: string }[] = [
  { style: "unified", label: "Unified" },
  { style: "split", label: "Split" },
];

function Toolbar({
  file,
  at,
  count,
  diffStyle,
  onGo,
  onDiffStyle,
}: {
  file: RangeFile;
  at: number;
  count: number;
  diffStyle: DiffStyle;
  onGo: (at: number) => void;
  onDiffStyle: (style: DiffStyle) => void;
}) {
  const word = statusWord(file);
  const label = pathLabel(file);
  return (
    <header className="file-diff-toolbar files-toolbar">
      <div className="files-steps" role="group" aria-label="Files">
        <button
          type="button"
          aria-label="Previous file"
          title="Previous file (K)"
          aria-disabled={at === 0}
          onClick={() => onGo(at - 1)}
        >
          <ChevronLeft size={14} aria-hidden="true" />
        </button>
        <span className="files-position">
          {(at + 1).toLocaleString()} of {count.toLocaleString()}
        </span>
        <button
          type="button"
          aria-label="Next file"
          title="Next file (J)"
          aria-disabled={at === count - 1}
          onClick={() => onGo(at + 1)}
        >
          <ChevronRight size={14} aria-hidden="true" />
        </button>
      </div>
      <span className="file-diff-path" title={label}>
        <bdi>{label}</bdi>
      </span>
      {word && <span className={`files-status ${word.tone}`}>{word.word}</span>}
      {file.added !== null && file.added + (file.deleted ?? 0) > 0 && (
        <LineTotals added={file.added} deleted={file.deleted} />
      )}
      <div
        className="diff-style"
        data-view={diffStyle}
        role="group"
        aria-label="Diff layout"
      >
        {styles.map(({ style, label }) => (
          <button
            key={style}
            type="button"
            aria-pressed={diffStyle === style}
            onClick={() => onDiffStyle(style)}
          >
            {label}
          </button>
        ))}
      </div>
    </header>
  );
}

function Stopped({
  stop,
  held,
  url,
  onRetry,
}: {
  stop: Stop;
  held: Held;
  url: string;
  onRetry: () => void;
}) {
  const { title, detail, verbatim, retry } = stopText(
    stop,
    held.range.repository.github,
  );
  return (
    <FilesState title={title} url={url} onRetry={retry ? onRetry : null}>
      {verbatim ? (
        <pre className="problem-detail" role="alert">
          {clampMessage(detail)}
        </pre>
      ) : (
        <p role="alert">{detail}</p>
      )}
    </FilesState>
  );
}

/** What a screen reader hears as the tab goes on. */
function said({ read, at }: Held): string {
  switch (read.kind) {
    case "reading":
      return "Reading the changes…";
    case "fetching":
      return "Getting the commits from GitHub…";
    case "stopped":
      return "";
    case "ready": {
      const file = read.files[at];
      return file
        ? `File ${(at + 1).toLocaleString()} of ${read.files.length.toLocaleString()}, ${pathLabel(file)}`
        : "";
    }
    default: {
      const exhaustive: never = read;
      return exhaustive;
    }
  }
}

const none: ReviewThread[] = [];

function Shown({
  pane,
  holdsFocus,
  unfolded,
  isShown,
  held,
  files: { ref, diffStyle, go, retry, whole },
  viewer,
  url,
}: {
  pane: RefObject<HTMLElement | null>;
  holdsFocus: RefObject<boolean>;
  unfolded: Unfolded;
  isShown: boolean;
  held: Held;
  files: FilesChangedState;
  viewer: string;
  url: string;
}) {
  const { read, at, enter, patches, pull } = held;
  const changed = read.kind === "ready" ? read.files : null;
  const threads = useMemo(
    () => threadsByFile(changed ?? [], pull.threads?.items ?? []),
    [changed, pull],
  );
  switch (read.kind) {
    case "reading":
      return <ReadingFiles />;
    case "fetching":
      return (
        <FilesState title="Getting the commits from GitHub…" url={url} busy>
          <p>This clone doesn&apos;t have all of them yet.</p>
        </FilesState>
      );
    case "stopped":
      return <Stopped stop={read.stop} held={held} url={url} onRetry={retry} />;
    case "ready": {
      const file = read.files[at];
      if (!file) return <FilesState title="No changes." url={url} />;
      return (
        <FileChanged
          key={`${held.range.head} ${read.mergeBase} ${at}`}
          ref={ref}
          pane={pane}
          holdsFocus={holdsFocus}
          unfolded={unfolded}
          isShown={isShown}
          file={file}
          enter={enter}
          patch={read.contentMissing ? null : (patches.get(file) ?? null)}
          contentMissing={read.contentMissing}
          threads={threads.get(file) ?? none}
          diffStyle={diffStyle}
          viewer={viewer}
          url={url}
          whole={() => whole(file)}
          onRetry={retry}
          onNext={at + 1 < read.files.length ? () => go(at + 1) : null}
        />
      );
    }
    default: {
      const exhaustive: never = read;
      return exhaustive;
    }
  }
}

export function FilesChanged({
  isShown,
  files,
  held,
  pull,
  viewer,
  url,
}: {
  /** Whether its tab is on screen. */
  isShown: boolean;
  files: FilesChangedState;
  held: Held;
  /** The newest read of it, which may have more than what is shown. */
  pull: PullRequest;
  viewer: string;
  /** Its page of changes on GitHub. */
  url: string;
}) {
  const pane = useRef<HTMLElement>(null);
  const holdsFocus = useRef(false);
  const [threads, setThreads] = useState<ReadonlySet<string>>(new Set());
  const toggle = useCallback(
    (thread: string) =>
      setThreads((open) => {
        const next = new Set(open);
        if (!next.delete(thread)) next.add(thread);
        return next;
      }),
    [],
  );
  const unfolded = useMemo(() => ({ threads, toggle }), [threads, toggle]);
  const { range, read, at } = held;
  const file = read.kind === "ready" ? read.files[at] : undefined;
  const newer = newerThan(range, pull, viewer);
  return (
    <section
      ref={pane}
      className="file-diff files-changed"
      aria-label="Files changed"
      tabIndex={-1}
    >
      {file && read.kind === "ready" && (
        <Toolbar
          file={file}
          at={at}
          count={read.files.length}
          diffStyle={files.diffStyle}
          onGo={files.go}
          onDiffStyle={files.setDiffStyle}
        />
      )}
      {newer && (
        <div className="notice info-notice" role="status">
          <RefreshCw size={14} />
          <span>{newer.text}</span>
          <button type="button" onClick={files.showNewest}>
            {newer.show}
          </button>
        </div>
      )}
      <span className="visually-hidden" role="status">
        {said(held)}
      </span>
      <Shown
        pane={pane}
        holdsFocus={holdsFocus}
        unfolded={unfolded}
        isShown={isShown}
        held={held}
        files={files}
        viewer={viewer}
        url={url}
      />
    </section>
  );
}
