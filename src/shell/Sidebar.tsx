import { ArrowLeft, GitPullRequest } from "lucide-react";
import { WorkspaceIcon } from "../components/WorkspaceIcon";
import type { Commands } from "../actions";
import { PaneDivider } from "../components/PaneDivider";
import { PullRequestFilters } from "../components/PullRequestFilters";
import { RepositoryTree } from "../components/RepositoryTree";
import type { UpdateRestart } from "../components/UpdateRestart";
import { UpdateAffordance } from "../components/UpdatesSettings";
import type { OperationProbe } from "../domain/merge";
import { waitingText } from "../domain/pullRequestList";
import type { RecentRepository } from "../domain/recents";
import type { RepositoryRoot } from "../domain/repository";
import type { RootSync } from "../overview";
import type { Updates } from "../updates";
import type { RefsState } from "../useRepositoryRefs";
import { SIDEBAR_WIDTH } from "./useLayout";
import type { Layout } from "./useLayout";
import type { SidebarNavigation } from "./useNavigation";
import type { SidebarRefActions } from "./useRefWrites";
import type { PullRequestsState } from "./usePullRequests";
import type { ScreenState } from "./useScreen";

export function Sidebar({
  layout,
  screen,
  pulls,
  commands,
  entries,
  expansion,
  refs,
  activePath,
  sync,
  operations,
  navigation,
  refActions,
  updates,
  restart,
}: {
  layout: Layout;
  screen: Pick<ScreenState, "place" | "settingsRef">;
  pulls: PullRequestsState;
  commands: Pick<Commands, "openSettings" | "showPullRequests" | "showHistory">;
  entries: RecentRepository[];
  expansion: {
    expanded: ReadonlySet<RepositoryRoot>;
    setExpanded: (root: RepositoryRoot, expanded: boolean) => void;
  };
  refs: ReadonlyMap<RepositoryRoot, RefsState>;
  activePath: RepositoryRoot | null;
  sync: ReadonlyMap<RepositoryRoot, RootSync>;
  operations: ReadonlyMap<RepositoryRoot, OperationProbe>;
  navigation: SidebarNavigation;
  refActions: SidebarRefActions;
  updates: Updates;
  restart: UpdateRestart;
}) {
  const onPulls = screen.place === "pullRequests";
  return (
    <>
      <aside
        hidden={!layout.sidebarOpen}
        className="sidebar"
        style={{ width: layout.paneWidths.sidebar }}
        aria-label={onPulls ? "Pull request sidebar" : "Repository sidebar"}
      >
        <div className="brand" data-tauri-drag-region />
        {onPulls && (
          <div className="repository-navigation">
            <PullRequestFilters
              model={pulls.model}
              choices={pulls.choices}
              onChoose={pulls.choose}
            />
          </div>
        )}
        <div className="repository-navigation" hidden={onPulls}>
          <RepositoryTree
            entries={entries}
            expanded={expansion.expanded}
            onToggle={(root) =>
              expansion.setExpanded(root, !expansion.expanded.has(root))
            }
            refs={refs}
            activePath={activePath}
            sync={sync}
            operations={operations}
            navigation={navigation}
            refActions={refActions}
          />
        </div>
        <footer className="sidebar-bottom">
          <button
            ref={screen.settingsRef}
            className="icon-button"
            aria-label="Settings"
            title="Settings"
            onClick={() => commands.openSettings()}
          >
            <WorkspaceIcon name="Settings" size={18} />
          </button>
          <PullRequestsEntry
            onPulls={onPulls}
            pulls={pulls}
            commands={commands}
          />
          <UpdateAffordance updates={updates} restart={restart} />
        </footer>
      </aside>
      {layout.sidebarOpen && (
        <PaneDivider
          label="Resize repository sidebar"
          width={layout.paneWidths.sidebar}
          min={SIDEBAR_WIDTH.min}
          max={SIDEBAR_WIDTH.max}
          direction={1}
          onResize={(width) => layout.resizePane("sidebar", width)}
          onResizeEnd={(width) => layout.savePaneWidth("sidebar", width)}
        />
      )}
    </>
  );
}

/** The way to the pull requests, which widens into the way back. */
function PullRequestsEntry({
  onPulls,
  pulls: { entryRef, waiting, opened },
  commands,
}: {
  onPulls: boolean;
  pulls: Pick<PullRequestsState, "entryRef" | "waiting" | "opened">;
  commands: Pick<Commands, "showPullRequests" | "showHistory">;
}) {
  if (onPulls)
    return (
      <button
        ref={entryRef}
        className="pull-entry back"
        title="Back to history"
        onClick={commands.showHistory}
      >
        <ArrowLeft size={14} />
        <span>Back to history</span>
        {opened === null && <kbd aria-hidden="true">Esc</kbd>}
      </button>
    );
  const badge = waiting === null || waiting === 0 ? null : waiting;
  return (
    <button
      ref={entryRef}
      className="icon-button pull-entry"
      aria-label={
        badge === null
          ? "Pull requests"
          : `Pull requests, ${waitingText(badge)}`
      }
      onClick={commands.showPullRequests}
    >
      <GitPullRequest size={18} />
      {badge !== null && (
        <span className="pull-badge" aria-hidden="true">
          {badge > 99 ? "99+" : badge}
        </span>
      )}
      <span className="pull-entry-tooltip" aria-hidden="true">
        Pull requests
        {badge !== null && <small>{waitingText(badge)}</small>}
      </span>
    </button>
  );
}
