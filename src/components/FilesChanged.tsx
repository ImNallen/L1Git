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
import { sinceRefusal } from "../domain/lineComments";
import type { LineAnchor } from "../domain/lineComments";
import { isSinceShown, shownFiles, sinceShown } from "../filesChanged";
import type { FilesChanged as Held } from "../filesChanged";
import type { FilesChangedState } from "../shell/useFilesChanged";
import type { OpenedPullRequest } from "../shell/usePullRequests";
import { AllFiles } from "./AllFiles";
import {
  ConversationWritingContext,
  useConversationWriting,
} from "./conversationWriting";
import { FileChanged } from "./FileChanged";
import { EndOfOne } from "./FileEnd";
import { FilesBoundary } from "./FilesBoundary";
import { FilesState, ReadingFiles } from "./FilesState";
import { FilesToolbar } from "./FilesToolbar";
import type { LinePlace } from "./KeepDiffPlace";
import type { Unfolded } from "./ReviewThreads";
import { OnGitHub } from "./PullRequestParts";
import { useFolded } from "./useFolded";
import { FinishReviewButton } from "./FinishReview";
import { SinceBar, SinceNotice } from "./SinceReview";
import { useFilesGoTo } from "./useFilesGoTo";
import type { Left } from "./useFilesGoTo";
import { useFinishReview } from "./useFinishReview";
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
function said(held: Held): string {
  const { read, at } = held;
  const since = isSinceShown(held) ? held.since?.read.kind : null;
  switch (since === "reading" || since === "fetching" ? since : read.kind) {
    case "reading":
      return "Reading the changes…";
    case "fetching":
      return "Getting the commits from GitHub…";
    case "stopped":
      return "";
    default: {
      const files = shownFiles(held);
      const file = files[at];
      return file
        ? `File ${(at + 1).toLocaleString()} of ${files.length.toLocaleString()}, ${pathLabel(file)}`
        : "";
    }
  }
}

const noSince: ReadonlyMap<RangeFile, RangeFile | null> = new Map();

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
  onOpenReview,
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
  /** Opens Finish review while its review may have posted, else null. */
  onOpenReview: (() => void) | null;
}) {
  return (
    <div className="files-notices">
      {onOpenReview && (
        <div className="notice warning-notice" role="status">
          <TriangleAlert size={14} aria-hidden="true" />
          <span>
            Your review may have posted. Finish review says what you can do.
          </span>
          <button type="button" onClick={onOpenReview}>
            Open Finish review
          </button>
        </div>
      )}
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

/** Where one of the two views was left, for the other, or with no view a
 * line to go to, for either. */

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
  const changed = shownFiles(held);
  const threads = useMemo(
    () => threadsByFile(changed, page?.items ?? []),
    [changed, page],
  );
  const isSince = isSinceShown(held);
  const nowOf = sinceShown(held)?.nowOf ?? noSince;
  /** A file of what changed since your review takes comments only on lines GitHub knows. */
  const refusal = (file: RangeFile, anchor: LineAnchor) => {
    if (!nowOf.has(file)) return null;
    const now = nowOf.get(file) ?? null;
    const own = now && patches?.get(now);
    return sinceRefusal(anchor, now, own?.kind === "ready" ? own.patch : null);
  };
  const since = isSince ? held.since?.read : undefined;
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
      if (since?.kind === "reading") return <ReadingFiles />;
      if (since?.kind === "fetching")
        return (
          <FilesState title="Getting the commits from GitHub…" url={url} busy>
            <p>This clone doesn&apos;t have the commit you reviewed yet.</p>
          </FilesState>
        );
      const file = changed[at];
      if (!file)
        return (
          <FilesState
            title={
              isSince
                ? "Nothing new from the author since your review."
                : "No changes."
            }
            url={url}
          />
        );
      const startsAt = () => {
        const { current: last } = left;
        // It is for this switch only.
        requestAnimationFrame(() => {
          if (left.current === last) left.current = null;
        });
        return last && last.view !== view && last.at === at ? last.line : null;
      };
      const next = nextUnviewed(changed, viewed, at);
      const shownKey = `${range.head} ${read.mergeBase} ${isSince ? `since ${held.since?.rebased}` : "all"}`;
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
          key={shownKey}
          {...shared}
          files={changed}
          nowOf={nowOf}
          refusal={refusal}
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
          key={`${shownKey} ${at}`}
          {...shared}
          file={file}
          isSince={nowOf.has(file)}
          refusal={(anchor) => refusal(file, anchor)}
          enter={enter}
          patch={patches?.get(file) ?? null}
          contentMissing={read.contentMissing}
          threads={threads.get(file) ?? none}
          whole={() => whole(file)}
          onRetry={() => onRetryFile(file)}
          below={
            <EndOfOne
              isViewed={viewed.has(file)}
              isSince={nowOf.has(file)}
              onMark={
                nowOf.get(file) === null
                  ? null
                  : (isViewed) => mark(file, isViewed)
              }
              onNextUnviewed={next === null ? null : () => go(next)}
              onNext={at + 1 < changed.length ? () => go(at + 1) : null}
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

function useToggled() {
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
  const unfold = (id: string) =>
    setToggled((before) => (before.has(id) ? before : new Set(before).add(id)));
  return [toggled, toggle, unfold] as const;
}

export function FilesChanged({
  isShown,
  files,
  held,
  pull,
  opened,
  url,
  showing,
  onShown,
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
  /** A thread to go to, as Show in diff asks. */
  showing: ReviewThread | null;
  onShown: () => void;
}) {
  const { viewer } = opened;
  const writing = useConversationWriting(opened, pull, url);
  const comments = useLineComments({ opened, head: held.range.head, pull });
  const finish = useFinishReview({ opened, pull, comments });
  const pane = useRef<HTMLElement>(null);
  const holdsFocus = useRef(false);
  const left = useRef<Left | null>(null);
  const [ids, toggle, unfold] = useToggled();
  const [folded, fold, unfoldFile] = useFolded(files.viewed);
  const unfolded = useMemo(() => ({ ids, toggle }), [ids, toggle]);
  const { range, read, at, counted, since } = held;
  const isSince = isSinceShown(held);
  const counts = useMemo(
    () =>
      read.kind === "ready" && !isSince ? countsNotice(read, counted) : null,
    [read, counted, isSince],
  );
  const shown = shownFiles(held);
  const file = shown[at];
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
  const { goToLines, openThread } = useFilesGoTo({
    held,
    files,
    unfold,
    folded,
    unfoldFile,
    left,
    showing,
    onShown,
  });
  // Its button goes away, and the focus would go with it.
  const keepingFocus = (act: () => void) => () => {
    pane.current?.focus({ preventScroll: true });
    act();
  };
  return (
    <ConversationWritingContext value={writing}>
      <LineCommentsContext value={comments}>
        <section
          ref={pane}
          className="file-diff files-changed"
          aria-label="Files changed"
          tabIndex={-1}
        >
          {since && (
            <SinceBar
              held={held}
              since={since}
              viewer={viewer}
              onShow={files.show}
              onRetry={keepingFocus(files.retrySince)}
            />
          )}
          {file && read.kind === "ready" && (
            <FilesToolbar
              files={shown}
              contentMissing={read.contentMissing}
              at={at}
              nowOf={sinceShown(held)?.nowOf ?? noSince}
              state={files}
            >
              <FinishReviewButton
                finish={finish}
                comments={comments}
                number={pull.number}
                author={pull.author}
                viewer={viewer}
                url={url}
                files={read.files}
                viewed={files.viewed}
                threads={pull.threads?.items ?? none}
                onGoTo={goToLines}
                onShowUnviewed={() => {
                  const next = nextUnviewed(read.files, files.viewed, -1);
                  if (next === null) return;
                  files.show("all");
                  files.go(next);
                }}
                onOpenThread={openThread}
              />
            </FilesToolbar>
          )}
          {since && (
            <SinceNotice
              held={held}
              since={since}
              viewer={viewer}
              onRebased={files.showRebased}
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
              onRetryFile={(of) =>
                keepingFocus(() => files.readFileAgain(of))()
              }
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
            onOpenReview={finish.unknown ? finish.open : null}
          />
        </section>
      </LineCommentsContext>
    </ConversationWritingContext>
  );
}
