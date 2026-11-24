import { useEffect, useImperativeHandle, useRef } from "react";
import type { Ref } from "react";
import { GitPullRequest } from "lucide-react";
import { flushSync } from "react-dom";
import type { HostStatus } from "../domain/host";
import { elsewhereText, viewLabels } from "../domain/pullRequestList";
import type { ListModel, Row } from "../domain/pullRequestList";
import { mac } from "../repositories";
import { focusIsShown } from "../shell/dom";
import type { Layout } from "../shell/useLayout";
import type { PullRequestsState } from "../shell/usePullRequests";
import type { Appearance } from "../themes/palette";
import { NoHost } from "./NoHost";
import { PullRequestDetail } from "./PullRequestDetail";
import type { PullRequestDetailHandle } from "./PullRequestDetail";
import {
  PullRequestColumns,
  PullRequestGroups,
  PullRequestSkeleton,
} from "./PullRequestList";
import { PullRequestMenus } from "./PullRequestMenus";
import { clock, PullRequestNotice } from "./PullRequestNotice";
import { useRovingRows } from "./useRovingRows";
import { WorkspaceIcon } from "./WorkspaceIcon";

export type PullRequestsHandle = {
  /** The open pull request, else the row it was opened from or the current
   * one, else the first control, else the screen itself. */
  focus: () => void;
  search: () => void;
};

/** The skeleton's rows are not links. */
const ROW = "a.pull-row";

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
  onOpen,
  onClearFilters,
}: {
  body: ListModel["body"];
  merged: boolean;
  onOpen: (row: Row, link: HTMLAnchorElement) => void;
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
          <PullRequestGroups groups={body.groups} onOpen={onOpen} />
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
  layout,
  theme,
  painted,
  onSignIn,
  onBack,
  onLeave,
}: {
  ref: Ref<PullRequestsHandle>;
  /** Null until Rust has said whether GitHub is connected. */
  status: HostStatus | null;
  hostProblem: string | null;
  onCheckHost: () => void;
  state: PullRequestsState;
  layout: Layout;
  theme: Appearance;
  painted: boolean;
  onSignIn: () => void;
  /** Back to the list. */
  onBack: () => void;
  onLeave: () => void;
}) {
  const { saved, model, choices, choose, opened } = state;
  const region = useRef<HTMLElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const detail = useRef<PullRequestDetailHandle>(null);
  useRovingRows(scroller, ROW, true);
  const rows = () => [
    ...(scroller.current?.querySelectorAll<HTMLAnchorElement>(ROW) ?? []),
  ];
  const openedFrom = useRef<{ href: string; row: number } | null>(null);
  function backToRow({ href, row }: { href: string; row: number }) {
    const all = rows();
    const next =
      all.find((each) => each.href === href) ??
      all[Math.min(row, all.length - 1)];
    if (!next) return false;
    next.focus({ preventScroll: true });
    // Only a list that was left for the history has lost its place.
    const bounds = scroller.current?.getBoundingClientRect();
    const { top, bottom } = next.getBoundingClientRect();
    if (bounds && (bottom <= bounds.top || top >= bounds.bottom))
      next.scrollIntoView({ block: "nearest" });
    return true;
  }
  function focus() {
    if (detail.current) return detail.current.focus();
    const from = openedFrom.current;
    openedFrom.current = null;
    if (from !== null && backToRow(from)) return;
    (
      scroller.current?.querySelector<HTMLElement>(`${ROW}[tabindex="0"]`) ??
      scroller.current?.querySelector<HTMLElement>(`${ROW}, button`) ??
      region.current
    )?.focus();
  }
  function open({ repository, pull }: Row, link: HTMLAnchorElement) {
    // WebKit focuses no link on a click, and the arrows go on from this one.
    link.focus({ preventScroll: true });
    openedFrom.current = { href: link.href, row: rows().indexOf(link) };
    state.open({ repository, number: pull.number });
  }
  const focused = useRef<{ element: HTMLElement; row: number } | null>(null);
  useEffect(() => {
    const { current } = focused;
    if (current === null || current.element.isConnected) return;
    focused.current = null;
    if (focusIsShown()) return;
    if (detail.current) return detail.current.focus();
    const all = rows();
    const next = all[Math.min(current.row, all.length - 1)] ?? region.current;
    next?.focus({ preventScroll: true });
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
      onFocus={({ target }) => {
        focused.current = {
          element: target,
          row: rows().findIndex((row) => row === target),
        };
      }}
      onBlur={({ target }) => {
        // A removed element may blur first, and only its removal moves focus.
        setTimeout(() => {
          if (target.isConnected && focused.current?.element === target)
            focused.current = null;
        });
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key !== "ArrowDown" && event.key !== "j") return;
        event.preventDefault();
        focus();
      }}
    >
      <div className="pull-list" hidden={opened !== null}>
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
            <PullRequestNotice
              key={
                notice.kind === "repository"
                  ? notice.repository.key
                  : `${notice.kind} ${"message" in notice ? notice.message : ""}`
              }
              notice={notice}
              shows="pull requests"
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
              onOpen={open}
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
      </div>
      {opened && (
        <PullRequestDetail
          key={opened.key}
          ref={detail}
          opened={opened}
          layout={layout}
          theme={theme}
          painted={painted}
          onBack={onBack}
          onRefresh={state.refresh}
        />
      )}
    </section>
  );
}
