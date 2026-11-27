import { useCallback, useMemo, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { RefreshCw, TriangleAlert, X } from "lucide-react";
import {
  countsNotice,
  newerThan,
  pathLabel,
  stopText,
} from "../domain/filesChanged";
import type { Stop } from "../domain/filesChanged";
import type { PullRequest, ReviewThread } from "../domain/pullRequest";
import type { RangeFile } from "../domain/range";
import { problemFrom } from "../domain/repository";
import { threadsByFile } from "../domain/reviewThreads";
import { nextUnviewed } from "../domain/viewedFiles";
import { clampMessage } from "../domain/worktree";
import type { FilesChanged as Held } from "../filesChanged";
import type { FilesChangedState, FilesView } from "../shell/useFilesChanged";
import type { OpenedPullRequest } from "../shell/usePullRequests";
import { AllFiles } from "./AllFiles";
import { FileChanged } from "./FileChanged";
import { EndOfOne } from "./FileEnd";
import { FilesBoundary } from "./FilesBoundary";
import { FilesState, ReadingFiles } from "./FilesState";
import { FilesToolbar } from "./FilesToolbar";
import type { LinePlace } from "./KeepDiffPlace";
import type { Unfolded } from "./ReviewThreads";
import { OnGitHub } from "./PullRequestParts";
import { useFolded } from "./useFolded";
import { LineCommentsContext, useLineComments } from "./useLineComments";

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

function Warning({
  children,
  onDismiss,
}: {
  children: ReactNode;
  onDismiss: () => void;
}) {
  return (
    <div className="notice warning-notice" role="status">
      <TriangleAlert size={14} aria-hidden="true" />
      <span>{children}</span>
      <button
        type="button"
        className="notice-dismiss"
        aria-label="Dismiss"
        onClick={onDismiss}
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

/** Over the end of the diff, which stays where it is. */
function Notices({
  newer,
  unsaved,
  problem,
  lines,
  onShow,
  onDismissUnsaved,
  onDismiss,
  onDismissLines,
}: {
  newer: ReturnType<typeof newerThan>;
  unsaved: string | null;
  problem: string | null;
  /** Why chosen lines opened no comment box. */
  lines: string | null;
  onShow: () => void;
  onDismissUnsaved: () => void;
  onDismiss: () => void;
  onDismissLines: () => void;
}) {
  return (
    <div className="files-notices">
      {lines !== null && <Warning onDismiss={onDismissLines}>{lines}</Warning>}
      {unsaved !== null && (
        <Warning onDismiss={onDismissUnsaved}>{unsaved}</Warning>
      )}
      {problem !== null && (
        <Warning onDismiss={onDismiss}>
          Couldn&apos;t show more lines. {problem}
        </Warning>
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

/** Where one of the two views was left, for the other. */
type Left = { view: FilesView; at: number; line: LinePlace };

function Shown({
  pane,
  holdsFocus,
  left,
  unfolded,
  folded,
  onFold,
  isShown,
  held,
  files: { ref, diffStyle, view, viewed, mark, go, readFile },
  whole,
  onRetry,
  onRetryFile,
  viewer,
  url,
}: {
  pane: RefObject<HTMLElement | null>;
  holdsFocus: RefObject<boolean>;
  left: RefObject<Left | null>;
  unfolded: Unfolded;
  folded: ReadonlySet<RangeFile>;
  onFold: (file: RangeFile) => void;
  isShown: boolean;
  held: Held;
  files: FilesChangedState;
  whole: (file: RangeFile) => Promise<string>;
  onRetry: () => void;
  onRetryFile: (file: RangeFile) => void;
  viewer: string;
  url: string;
}) {
  const {
    read,
    at,
    enter,
    patches,
    range,
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
      const startsAt = () => {
        const { current: last } = left;
        // It is for this switch only.
        requestAnimationFrame(() => {
          if (left.current === last) left.current = null;
        });
        return last && last.view !== view && last.at === at ? last.line : null;
      };
      const next = nextUnviewed(read.files, viewed, at);
      const onLeave = (of: number, line: LinePlace) => {
        left.current = { view, at: of, line };
      };
      const shared = {
        ref,
        pane,
        holdsFocus,
        startsAt,
        head: range.head,
        unfolded,
        isShown,
        diffStyle,
        viewer,
        url,
      };
      return view === "all" ? (
        <AllFiles
          key={`${range.head} ${read.mergeBase}`}
          {...shared}
          files={read.files}
          contentMissing={read.contentMissing}
          patches={patches}
          at={at}
          threads={threads}
          viewed={viewed}
          onMark={mark}
          folded={folded}
          onFold={onFold}
          whole={whole}
          onAt={go}
          onRead={readFile}
          onReadAgain={onRetryFile}
          onLeave={onLeave}
        />
      ) : (
        <FileChanged
          key={`${range.head} ${read.mergeBase} ${at}`}
          {...shared}
          file={file}
          enter={enter}
          patch={patches?.get(file) ?? null}
          contentMissing={read.contentMissing}
          threads={threads.get(file) ?? none}
          whole={() => whole(file)}
          onRetry={() => onRetryFile(file)}
          below={
            <EndOfOne
              isViewed={viewed.has(file)}
              onMark={(isViewed) => mark(file, isViewed)}
              onNextUnviewed={next === null ? null : () => go(next)}
              onNext={at + 1 < read.files.length ? () => go(at + 1) : null}
            />
          }
          onLeave={(line) => onLeave(at, line)}
        />
      );
    }
    default: {
      const exhaustive: never = read;
      return exhaustive;
    }
  }
}

function useToggled(): [ReadonlySet<string>, (id: string) => void] {
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
  const toggle = useCallback(
    (id: string) =>
      setToggled((before) => {
        const next = new Set(before);
        if (!next.delete(id)) next.add(id);
        return next;
      }),
    [],
  );
  return [toggled, toggle];
}

export function FilesChanged({
  isShown,
  files,
  held,
  pull,
  opened,
  url,
}: {
  /** Whether its tab is on screen. */
  isShown: boolean;
  files: FilesChangedState;
  held: Held;
  /** The newest read of it, which may have more than what is shown. */
  pull: PullRequest;
  opened: Pick<
    OpenedPullRequest,
    "writing" | "viewer" | "repository" | "number"
  >;
  /** Its page of changes on GitHub. */
  url: string;
}) {
  const { viewer } = opened;
  const comments = useLineComments({ opened, head: held.range.head, pull });
  const pane = useRef<HTMLElement>(null);
  const holdsFocus = useRef(false);
  const left = useRef<Left | null>(null);
  const [ids, toggle] = useToggled();
  const [folded, fold] = useFolded(files.viewed);
  const unfolded = useMemo(() => ({ ids, toggle }), [ids, toggle]);
  const { range, read, at, counted } = held;
  const counts = useMemo(
    () => (read.kind === "ready" ? countsNotice(read, counted) : null),
    [read, counted],
  );
  const file = read.kind === "ready" ? read.files[at] : undefined;
  const newer = read.kind === "reading" ? null : newerThan(range, pull, viewer);
  const [problem, setProblem] = useState<{
    file: RangeFile;
    message: string;
  } | null>(null);
  const { persistenceError } = files;
  const [seen, setSeen] = useState<string | null>(null);
  if (persistenceError === null && seen !== null) setSeen(null);
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
    <LineCommentsContext value={comments}>
      <section
        ref={pane}
        className="file-diff files-changed"
        aria-label="Files changed"
        tabIndex={-1}
      >
        {file && read.kind === "ready" && (
          <FilesToolbar
            files={read.files}
            contentMissing={read.contentMissing}
            at={at}
            state={files}
          />
        )}
        {counts !== null && (
          <p className="files-counts">
            {counts} <OnGitHub url={url} />
          </p>
        )}
        <span className="visually-hidden" role="status">
          {said(held)}
        </span>
        <FilesBoundary
          key={`${files.view} ${files.view === "one" ? at : ""} ${range.head}`}
          url={url}
          onRetry={keepingFocus(() => {})}
        >
          <Shown
            pane={pane}
            holdsFocus={holdsFocus}
            left={left}
            unfolded={unfolded}
            folded={folded}
            onFold={fold}
            isShown={isShown}
            held={held}
            files={files}
            whole={whole}
            onRetry={keepingFocus(files.retry)}
            onRetryFile={(of) => keepingFocus(() => files.readFileAgain(of))()}
            viewer={viewer}
            url={url}
          />
        </FilesBoundary>
        <Notices
          newer={newer}
          unsaved={persistenceError === seen ? null : persistenceError}
          problem={
            problem && (files.view === "all" || problem.file === file)
              ? problem.message
              : null
          }
          lines={comments.notice}
          onShow={keepingFocus(files.showNewest)}
          onDismissUnsaved={keepingFocus(() => setSeen(persistenceError))}
          onDismiss={keepingFocus(() => setProblem(null))}
          onDismissLines={keepingFocus(comments.dismissNotice)}
        />
      </section>
    </LineCommentsContext>
  );
}
