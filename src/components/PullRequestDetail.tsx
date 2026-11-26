import {
  Suspense,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
} from "react";
import type { PullRequestCheckout } from "../shell/usePullRequestCheckout";
import type { KeyboardEvent, ReactNode, Ref } from "react";
import {
  ArrowLeft,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { flushSync } from "react-dom";
import type { PullRequest } from "../domain/pullRequest";
import {
  conversationCount,
  detailNotice,
  headline,
  headName,
  pullState,
} from "../domain/pullRequestDetail";
import type { PullState } from "../domain/pullRequestDetail";
import { pullRequestUrl, stateLabels } from "../domain/pullRequestList";
import { markdownReader } from "../markdown/markdownReader";
import { INSPECTOR_WIDTH } from "../shell/useLayout";
import type { Layout } from "../shell/useLayout";
import { FilesChanged } from "../shell/lazyViews";
import { FilesBoundary } from "./FilesBoundary";
import type { FilesChangedState } from "../shell/useFilesChanged";
import type {
  OpenedPullRequest,
  PullRequestTab,
} from "../shell/usePullRequests";
import type { Appearance } from "../themes/palette";
import { CopyButton } from "./CopyButton";
import { ReadingFiles } from "./FilesState";
import { KeepPlace } from "./KeepPlace";
import { PaneDivider } from "./PaneDivider";
import { PullRequestChecks } from "./PullRequestChecks";
import { PullRequestCommits } from "./PullRequestCommits";
import { PullRequestFailure } from "./PullRequestFailure";
import { PullRequestConversation } from "./PullRequestConversation";
import { PullRequestInspector } from "./PullRequestInspector";
import { PullRequestCheckoutBar } from "./PullRequestCheckoutBar";
import { PullRequestNotice } from "./PullRequestNotice";
import { Ago } from "./PullRequestParts";
import { SurroundingsContext } from "./pullRequestText";
import { TryPullRequest } from "./TryPullRequest";
import { useRefocusWhenWriteEnds } from "./useRefocusWhenWriteEnds";

const tabs = {
  conversation: { label: "Conversation", count: conversationCount },
  commits: {
    label: "Commits",
    count: ({ commits }: PullRequest) => commits.total.toLocaleString(),
  },
  files: {
    label: "Files changed",
    count: ({ changedFiles }: PullRequest) => changedFiles.toLocaleString(),
  },
  checks: {
    label: "Checks",
    count: ({ checks }: PullRequest) => checks?.total.toLocaleString() ?? "–",
  },
} as const satisfies Record<PullRequestTab, unknown>;
const order = Object.keys(tabs) as PullRequestTab[];

const stateIcons: Record<PullState, LucideIcon> = {
  open: GitPullRequest,
  draft: GitPullRequestDraft,
  merged: GitMerge,
  closed: GitPullRequestClosed,
};

function Header({
  opened: { repository, number, summary, read, viewer },
  titleId,
  titleRef,
}: {
  opened: OpenedPullRequest;
  titleId: string;
  titleRef: Ref<HTMLHeadingElement>;
}) {
  const { value } = read;
  const pull = value ?? summary;
  const state = pull && pullState(pull);
  const Icon = state && stateIcons[state];
  const head = value ? headName(value) : (summary?.head ?? null);
  return (
    <div className="pull-detail-header">
      <h2 id={titleId} ref={titleRef} tabIndex={-1} dir="auto">
        {pull?.title ?? repository.name}{" "}
        <bdi className="pull-detail-number">#{number}</bdi>
      </h2>
      {pull && state && Icon && (
        <div className="pull-detail-meta">
          <span className={`pull-state-pill ${state}`}>
            <Icon size={14} aria-hidden="true" />
            {stateLabels[state]}
          </span>
          <span>{headline(pull, value, viewer)}</span>
          <code className="pull-branch" title={pull.base}>
            {pull.base}
          </code>
          <span>from</span>
          <code className="pull-branch" title={head ?? undefined}>
            {head}
          </code>
          <CopyButton
            text={value?.head.branch ?? summary?.head ?? ""}
            what="branch"
          />
          <span className="pull-detail-time">
            <span className="entry-dot">·</span>{" "}
            {pull.state.kind === "open" ? (
              <>
                Updated <Ago at={pull.updatedAt} />
              </>
            ) : (
              <Ago at={pull.state.at} />
            )}
          </span>
        </div>
      )}
    </div>
  );
}

function Skeleton() {
  return (
    <div className="detail-skeleton" aria-hidden="true">
      {[true, false, false, true].map((card, index) => (
        <div className="entry" key={index}>
          <i className="dot" />
          <div className={card ? "entry-card" : ""}>
            <i className="short" />
            <i className="long" />
            {card && <i className="longer" />}
          </div>
        </div>
      ))}
    </div>
  );
}

function Panel({
  id,
  of,
  labelledBy,
  busy,
  hidden,
  children,
}: {
  id: string;
  of: PullRequestTab;
  labelledBy: string;
  busy: boolean;
  hidden: boolean;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const scrolls = of !== "files";
  return (
    <>
      <div
        ref={panel}
        id={id}
        className="pull-panel"
        data-tab={of}
        role="tabpanel"
        aria-labelledby={labelledBy}
        aria-busy={busy}
        tabIndex={scrolls ? 0 : undefined}
        hidden={hidden}
      >
        {children}
      </div>
      {scrolls && <KeepPlace panel={panel} />}
    </>
  );
}

export type PullRequestDetailHandle = { focus: () => void };

export function PullRequestDetail({
  ref,
  isShown,
  opened,
  files,
  checkout,
  layout,
  theme,
  painted,
  onTab,
  onBack,
  onRefresh,
}: {
  ref: Ref<PullRequestDetailHandle>;
  /** Whether it is on screen. */
  isShown: boolean;
  opened: OpenedPullRequest;
  files: FilesChangedState;
  checkout: PullRequestCheckout;
  layout: Pick<
    Layout,
    "inspectorOpen" | "paneWidths" | "resizePane" | "savePaneWidth"
  >;
  theme: Appearance;
  painted: boolean;
  onTab: (tab: PullRequestTab) => void;
  onBack: () => void;
  onRefresh: (() => void) | null;
}) {
  const { repository, number, tab, read, position, viewer } = opened;
  const { value: pull, problem } = read;
  const id = useId();
  const title = useRef<HTMLHeadingElement>(null);
  useImperativeHandle(ref, () => ({
    focus: () => title.current?.focus({ preventScroll: true }),
  }));
  useEffect(() => markdownReader.warm(), []);
  const bar = useRef<HTMLDivElement>(null);
  const tryButton = useRef<HTMLButtonElement>(null);
  useRefocusWhenWriteEnds(
    checkout.running,
    isShown,
    () => bar.current ?? tryButton.current ?? title.current,
  );
  const url = pullRequestUrl(repository.github, number);
  const { owner, repo } = repository.github;
  const notice = detailNotice(read, repository);
  const loading = pull === null && problem === null;
  const tabId = (of: PullRequestTab) => `${id}-${of}`;
  const panelId = (of: PullRequestTab) => `${id}-${of}-panel`;
  const surroundings = useMemo(
    () => ({ base: `https://github.com/${owner}/${repo}/`, theme, painted }),
    [owner, repo, theme, painted],
  );
  const show = (next: PullRequestTab) => {
    flushSync(() => onTab(next));
    document.getElementById(tabId(next))?.focus();
  };
  function steer(event: KeyboardEvent) {
    const at = order.indexOf(tab);
    const next = {
      ArrowRight: order[(at + 1) % order.length],
      ArrowLeft: order[(at + order.length - 1) % order.length],
      Home: order[0],
      End: order.at(-1),
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    show(next);
  }

  return (
    <>
      <article className="pull-detail" aria-labelledby={`${id}-title`}>
        <header
          className="toolbar pull-toolbar pull-detail-toolbar"
          data-tauri-drag-region
        >
          <button type="button" className="pull-back" onClick={onBack}>
            <ArrowLeft size={14} aria-hidden="true" />
            Pull requests
          </button>
          <span className="pull-crumbs">
            <span className="pull-crumb" title={`${owner}/${repo}`}>
              {repository.name}
            </span>
            <span className="pull-crumb here">#{number}</span>
          </span>
          {position && (
            <span className="pull-position">
              {position.at.toLocaleString()} of {position.of.toLocaleString()}
            </span>
          )}
          {checkout.offer && (
            <TryPullRequest
              ref={tryButton}
              number={number}
              offer={checkout.offer}
              onCreate={checkout.tryLocally}
            />
          )}
          <a
            className="button secondary"
            href={tab === "files" ? `${url}/files` : url}
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink size={14} aria-hidden="true" />
            Open on GitHub
          </a>
        </header>
        <Header opened={opened} titleId={`${id}-title`} titleRef={title} />
        {pull && (
          <PullRequestCheckoutBar
            ref={bar}
            checkout={checkout}
            head={pull.head.oid}
          />
        )}
        <span className="visually-hidden" role="status">
          {loading ? "Loading pull request…" : ""}
        </span>
        <div
          className="pull-tabs"
          role="tablist"
          aria-label="Pull request"
          onKeyDown={steer}
        >
          {order.map((of) => (
            <button
              key={of}
              type="button"
              id={tabId(of)}
              role="tab"
              aria-selected={tab === of}
              aria-controls={panelId(of)}
              tabIndex={tab === of ? 0 : -1}
              onClick={() => onTab(of)}
            >
              {tabs[of].label}
              <span className="pull-tab-count">
                {pull ? tabs[of].count(pull) : "–"}
              </span>
            </button>
          ))}
        </div>
        {notice && (
          <PullRequestNotice
            notice={notice}
            shows="this pull request"
            onRefresh={onRefresh}
          />
        )}
        {order
          // What was expanded stays so behind another tab.
          .filter(
            (of) =>
              of === tab ||
              (of === "conversation" && pull) ||
              (of === "files" && files.held),
          )
          .map((of) => (
            <Panel
              key={of}
              of={of}
              id={panelId(of)}
              labelledBy={tabId(of)}
              busy={read.reading}
              hidden={of !== tab}
            >
              <SurroundingsContext value={surroundings}>
                {pull === null ? (
                  loading ? (
                    <Skeleton />
                  ) : (
                    <PullRequestFailure
                      opened={opened}
                      url={url}
                      onBack={onBack}
                      onRefresh={onRefresh}
                    />
                  )
                ) : of === "conversation" ? (
                  <PullRequestConversation
                    pull={pull}
                    viewer={viewer}
                    url={url}
                  />
                ) : of === "commits" ? (
                  <PullRequestCommits pull={pull} viewer={viewer} url={url} />
                ) : of === "files" ? (
                  <FilesBoundary url={`${url}/files`}>
                    <Suspense fallback={<ReadingFiles />}>
                      {files.held && (
                        <FilesChanged
                          isShown={isShown && of === tab}
                          files={files}
                          held={files.held}
                          pull={pull}
                          viewer={viewer}
                          url={`${url}/files`}
                        />
                      )}
                    </Suspense>
                  </FilesBoundary>
                ) : (
                  <PullRequestChecks pull={pull} url={url} />
                )}
              </SurroundingsContext>
            </Panel>
          ))}
      </article>
      {layout.inspectorOpen && (
        <>
          <PaneDivider
            label="Resize pull request details"
            width={layout.paneWidths.inspector}
            min={INSPECTOR_WIDTH.min}
            max={INSPECTOR_WIDTH.max}
            direction={-1}
            onResize={(width) => layout.resizePane("inspector", width)}
            onResizeEnd={(width) => layout.savePaneWidth("inspector", width)}
          />
          <div
            className="inspector-container"
            style={{ width: layout.paneWidths.inspector }}
          >
            <PullRequestInspector
              opened={opened}
              files={files}
              onShowChecks={() => show("checks")}
            />
          </div>
        </>
      )}
    </>
  );
}
