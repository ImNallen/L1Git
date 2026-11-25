import { useCallback, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import {
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  TriangleAlert,
  X,
} from "lucide-react";
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
import { problemFrom } from "../domain/repository";
import { threadsByFile } from "../domain/reviewThreads";
import { clampMessage } from "../domain/worktree";
import type { FilesChanged as Held } from "../filesChanged";
import type { FilesChangedState } from "../shell/useFilesChanged";
import { FileChanged } from "./FileChanged";
import type { Unfolded } from "./FileChanged";
import { FilesState, ReadingFiles } from "./FilesState";
import { LineTotals } from "./LineTotals";
import { OnGitHub } from "./PullRequestParts";

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
      {detail === null ? null : verbatim ? (
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

/** Over the end of the diff, which stays where it is. */
function Notices({
  newer,
  problem,
  onShow,
  onDismiss,
}: {
  newer: ReturnType<typeof newerThan>;
  problem: string | null;
  onShow: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="files-notices">
      {problem !== null && (
        <div className="notice warning-notice" role="status">
          <TriangleAlert size={14} aria-hidden="true" />
          <span>Couldn&apos;t show more lines. {problem}</span>
          <button
            type="button"
            className="notice-dismiss"
            aria-label="Dismiss"
            onClick={onDismiss}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      )}
      {newer && (
        <div className="notice info-notice" role="status">
          <RefreshCw size={14} aria-hidden="true" />
          <span>{newer.text}</span>
          <button type="button" onClick={onShow}>
            {newer.show}
          </button>
        </div>
      )}
    </div>
  );
}

const none: ReviewThread[] = [];

function Shown({
  pane,
  holdsFocus,
  unfolded,
  isShown,
  held,
  files: { ref, diffStyle, go },
  whole,
  onRetry,
  viewer,
  url,
}: {
  pane: RefObject<HTMLElement | null>;
  holdsFocus: RefObject<boolean>;
  unfolded: Unfolded;
  isShown: boolean;
  held: Held;
  files: FilesChangedState;
  whole: (file: RangeFile) => Promise<string>;
  onRetry: () => void;
  viewer: string;
  url: string;
}) {
  const {
    read,
    at,
    enter,
    patches,
    pull: { threads: page },
  } = held;
  const changed = read.kind === "ready" ? read.files : null;
  const threads = useMemo(
    () => threadsByFile(changed ?? [], page?.items ?? []),
    [changed, page],
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
      return (
        <Stopped stop={read.stop} held={held} url={url} onRetry={onRetry} />
      );
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
          onRetry={onRetry}
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
  const newer = read.kind === "reading" ? null : newerThan(range, pull, viewer);
  const [problem, setProblem] = useState<{
    file: RangeFile;
    message: string;
  } | null>(null);
  const whole = (of: RangeFile) =>
    files.whole(of).catch((error: unknown) => {
      setProblem({ file: of, message: problemFrom(error).message });
      throw error;
    });
  // Its button goes away, and the focus would go with it.
  const keepingFocus = (act: () => void) => () => {
    pane.current?.focus({ preventScroll: true });
    act();
  };
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
      {read.kind === "ready" && read.counts !== null && (
        <p className="files-counts">
          {read.counts} <OnGitHub url={url} />
        </p>
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
        whole={whole}
        onRetry={keepingFocus(files.retry)}
        viewer={viewer}
        url={url}
      />
      <Notices
        newer={newer}
        problem={problem?.file === file ? (problem?.message ?? null) : null}
        onShow={keepingFocus(files.showNewest)}
        onDismiss={keepingFocus(() => setProblem(null))}
      />
    </section>
  );
}
