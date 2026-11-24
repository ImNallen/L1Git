import { useEffect, useImperativeHandle, useRef } from "react";
import type { Ref } from "react";
import { GitPullRequest, Plug, TriangleAlert } from "lucide-react";
import { flushSync } from "react-dom";
import type { HostStatus } from "../domain/host";
import { elsewhereText, viewLabels } from "../domain/pullRequestList";
import type { ListModel, Notice } from "../domain/pullRequestList";
import { relativeTime } from "../domain/time";
import { mac } from "../repositories";
import { focusIsShown } from "../shell/dom";
import type { PullRequestsState } from "../shell/usePullRequests";
import { NoHost } from "./NoHost";
import {
  PullRequestColumns,
  PullRequestGroups,
  PullRequestSkeleton,
} from "./PullRequestList";
import { PullRequestMenus } from "./PullRequestMenus";
import { useRovingRows } from "./useRovingRows";
import { WorkspaceIcon } from "./WorkspaceIcon";

export type PullRequestsHandle = {
  /** The current row, else the first control, else the screen itself. */
  focus: () => void;
  search: () => void;
};

/** The skeleton's rows are not links. */
const ROW = "a.pull-row";

/** "14:02", with the day once it is not today. */
function clock(at: number): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString(undefined, { timeStyle: "short" });
  return date.toDateString() === new Date().toDateString()
    ? time
    : `${date.toLocaleDateString()} ${time}`;
}

function NoticeRow({
  notice,
  onRefresh,
}: {
  notice: Notice;
  onRefresh: (() => void) | null;
}) {
  switch (notice.kind) {
    case "offline":
      return (
        <div className="notice info-notice" role="status">
          <Plug size={14} />
          <span>
            {notice.at === null
              ? "Offline. No pull requests were read yet."
              : `Offline. Showing pull requests as of ${clock(notice.at)}, ${relativeTime(notice.at / 1_000)}.`}
          </span>
          <button type="button" onClick={onRefresh ?? undefined}>
            Try again
          </button>
        </div>
      );
    case "connection":
      return (
        <div className="notice warning-notice" role="status">
          <TriangleAlert size={14} />
          <span>{notice.message}</span>
          <button type="button" onClick={onRefresh ?? undefined}>
            Try again
          </button>
        </div>
      );
    case "repository":
      return (
        <div className="notice warning-notice" role="status">
          <TriangleAlert size={14} />
          <span>
            <strong>Couldn&apos;t read {notice.repository.name}.</strong>{" "}
            {notice.message}
          </span>
          {notice.authorize !== null && (
            <a href={notice.authorize} target="_blank" rel="noreferrer">
              Authorize on GitHub
            </a>
          )}
        </div>
      );
    case "more":
      return (
        <div className="notice warning-notice" role="status">
          <TriangleAlert size={14} />
          <span>And {notice.count.toLocaleString()} more.</span>
        </div>
      );
    default: {
      const exhaustive: never = notice;
      return exhaustive;
    }
  }
}

function Empty({
  title,
  detail,
  action,
}: {
  title: string;
  detail?: string;
  action?: { label: string; run: () => void };
}) {
  return (
    <div className="pull-empty">
      <span className="no-host-glyph">
        <GitPullRequest size={16} />
      </span>
      <h3>{title}</h3>
      {detail && <p>{detail}</p>}
      {action && (
        <button type="button" className="button secondary" onClick={action.run}>
          {action.label}
        </button>
      )}
    </div>
  );
}

function Body({
  body,
  merged,
  onClearFilters,
}: {
  body: ListModel["body"];
  merged: boolean;
  onClearFilters: () => void;
}) {
  switch (body.kind) {
    case "unread":
      return null;
    case "nothing":
      return <Empty title={body.title} detail={body.detail} />;
    case "noMatches":
      return (
        <Empty
          title="No matches"
          action={{ label: "Clear filters", run: onClearFilters }}
        />
      );
    case "loading":
      return (
        <>
          <PullRequestColumns merged={merged} />
          <PullRequestSkeleton />
        </>
      );
    case "rows":
      return (
        <>
          <PullRequestColumns merged={merged} />
          <PullRequestGroups groups={body.groups} />
          {body.everything && (
            <div className="pull-everything">
              <p>That&apos;s everything waiting on you.</p>
              <p>
                A pull request leaves this view once you approve it, comment on
                it, or request changes.
              </p>
            </div>
          )}
        </>
      );
    default: {
      const exhaustive: never = body;
      return exhaustive;
    }
  }
}

export function PullRequests({
  ref,
  status,
  hostProblem,
  onCheckHost,
  state,
  onSignIn,
  onLeave,
}: {
  ref: Ref<PullRequestsHandle>;
  /** Null until Rust has said whether GitHub is connected. */
  status: HostStatus | null;
  hostProblem: string | null;
  onCheckHost: () => void;
  state: PullRequestsState;
  onSignIn: () => void;
  onLeave: () => void;
}) {
  const { saved, model, choices, choose } = state;
  const region = useRef<HTMLElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  useRovingRows(scroller, ROW, true);
  const focus = () =>
    (
      scroller.current?.querySelector<HTMLElement>(`${ROW}[tabindex="0"]`) ??
      scroller.current?.querySelector<HTMLElement>(`${ROW}, button`) ??
      region.current
    )?.focus();
  const focused = useRef<EventTarget | null>(null);
  useEffect(() => {
    const { current } = focused;
    if (!(current instanceof Node) || current.isConnected) return;
    focused.current = null;
    if (!focusIsShown()) focus();
  });
  useImperativeHandle(ref, () => ({
    focus,
    search: () => {
      search.current?.focus();
      search.current?.select();
    },
  }));

  const github = status?.github;
  const listing = github?.kind === "connected" && saved.listed.length > 0;
  const offline = state.notices.find(({ kind }) => kind === "offline");
  const asOf = offline?.kind === "offline" ? offline.at : null;
  const footnotes = [
    ...(listing && model.body.kind !== "loading" ? model.cuts : []),
    ...(listing && saved.elsewhere > 0 ? [elsewhereText(saved.elsewhere)] : []),
  ];

  return (
    <section
      ref={region}
      className="pull-requests"
      aria-label="Pull requests"
      tabIndex={-1}
      onFocus={(event) => {
        focused.current = event.target;
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key !== "ArrowDown" && event.key !== "j") return;
        event.preventDefault();
        focus();
      }}
    >
      <header className="toolbar pull-toolbar" data-tauri-drag-region>
        <h2>{viewLabels[choices.view]}</h2>
        <span className="pull-scope" role="status">
          {listing &&
            (asOf === null
              ? model.scope
              : `${model.scope}, as of ${clock(asOf)}`)}
        </span>
        {listing && (
          <div className="pull-search" role="search">
            <WorkspaceIcon name="SettingsSearch" />
            <input
              ref={search}
              aria-label="Search pull requests"
              placeholder="Search title, number, branch or author"
              spellCheck={false}
              autoComplete="off"
              value={choices.query}
              onChange={(event) => choose({ query: event.target.value })}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  if (choices.query === "") onLeave();
                  else choose({ query: "" });
                } else if (event.key === "ArrowDown") {
                  event.preventDefault();
                  focus();
                }
              }}
            />
            <kbd aria-hidden="true">{mac ? "⌘ F" : "Ctrl F"}</kbd>
          </div>
        )}
      </header>
      {listing &&
        state.notices.map((notice) => (
          <NoticeRow
            key={
              notice.kind === "repository"
                ? notice.repository.key
                : `${notice.kind} ${"message" in notice ? notice.message : ""}`
            }
            notice={notice}
            onRefresh={state.refresh}
          />
        ))}
      {listing && (
        <PullRequestMenus
          choices={choices}
          authors={model.authors}
          onChoose={choose}
        />
      )}
      <div ref={scroller} className="pull-scroll" aria-busy={state.reading}>
        {github === undefined ? (
          hostProblem !== null && (
            <Empty
              title="Couldn't check the GitHub connection"
              detail={hostProblem}
              action={{ label: "Try again", run: onCheckHost }}
            />
          )
        ) : github.kind === "notConnected" ? (
          <div className="pull-no-host">
            <NoHost ended={github.ended} onSignIn={onSignIn} />
          </div>
        ) : saved.listed.length === 0 ? (
          !saved.opening && (
            <Empty
              title="No saved repository is on GitHub"
              detail="L1 Git lists pull requests of saved repositories that have a github.com remote."
            />
          )
        ) : (
          <Body
            body={model.body}
            merged={choices.view === "merged"}
            onClearFilters={() => {
              flushSync(state.clearFilters);
              focus();
            }}
          />
        )}
        {footnotes.map((note) => (
          <p className="pull-note" key={note}>
            {note}
          </p>
        ))}
      </div>
    </section>
  );
}
