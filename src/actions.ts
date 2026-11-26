import type { PullTarget, SyncTarget } from "./domain/overview";
import type { PushControl } from "./domain/push";
import { distinctNames } from "./domain/repositoryNames";
import { normalizeSearch } from "./domain/search";
import { replayEntry } from "./domain/merge";
import type {
  FullRef,
  Oid,
  ReplayKind,
  RepositoryRoot,
  Stash,
} from "./domain/repository";
import type { Selection } from "./domain/selection";
import type { PartAction } from "./domain/operations";
import type { BranchVisibility, VisibilityRule } from "./domain/visibility";
import { shortOid } from "./domain/shortOid";

/** The two screens Settings opens over. */
export type Place = "repository" | "pullRequests";
export type Screen = Place | "settings";
export const settingsSections = [
  { id: "general", label: "General", icon: "SettingsGeneral" },
  { id: "appearance", label: "Appearance", icon: "SettingsPalette" },
  { id: "hosts", label: "Hosts", icon: "SettingsHosts" },
] as const;
export type SettingsSection = (typeof settingsSections)[number]["id"];
export type FileView = "unified" | "split" | "history" | "blame";

export type ActionContext = {
  screen: Screen;
  place: Place;
  section: SettingsSection;
  dialogOpen: boolean;
  adding: boolean;
  searchable: boolean;
  inspectable: boolean;
  /** Whether one pull request shows in place of the list. */
  pullRequestOpen: boolean;
  /** Where the Files changed tab is among its files, while it shows one. */
  filesChanged: { at: number; count: number; isViewed: boolean } | null;
  push: PushControl | null;
  repository: {
    fetching: boolean;
    idle: boolean;
    ready: number;
    fetch: SyncTarget;
  } | null;
  file: { hasCommit: boolean; lineActions: readonly PartAction[] } | null;
  selection: Selection | null;
  picked: Oid | null;
  compare: { swappable: boolean } | null;
  sidebarBranch: {
    name: string;
    visibility: BranchVisibility;
    outOfView: boolean;
    local: boolean;
    checkedOut: boolean;
    /** The linked worktree that holds this branch, when Remove worktree can take it away. */
    removableWorktree: string | null;
  } | null;
  sidebarTag: { name: string } | null;
  rule: VisibilityRule["kind"];
  worktree: {
    unstaged: number;
    staged: number;
    conflicts?: number;
    discardable: number;
  } | null;
  history: { undo: string | null; redo: string | null };
  writing: boolean;
  merging: boolean;
  mergeAvailable: boolean;
  selectedMergeAvailable: boolean;
  /** Null unless the active worktree could start one. `branch` is null when it is on no branch. */
  replay: { branch: string | null } | null;
  /** The active worktree's branch, which Pull updates. */
  pull: PullTarget;
  typing: boolean;
  menuOpen: boolean;
};

export type Commands = {
  addRepository: () => void;
  openSettings: (section?: SettingsSection) => void;
  leaveSettings: () => void;
  showPullRequests: () => void;
  showHistory: () => void;
  searchPullRequests: () => void;
  closePullRequest: () => void;
  nextFile: () => void;
  previousFile: () => void;
  nextChange: () => void;
  previousChange: () => void;
  toggleViewed: () => void;
  toggleSidebar: () => void;
  toggleInspector: () => void;
  fetch: () => void;
  fetchAll: () => void;
  fastForward: () => void;
  pullFastForwardIfPossible: () => void;
  pullFastForwardOnly: () => void;
  pullRebase: () => void;
  mergeUpstream: () => void;
  mergeBranch: () => void;
  replay: (kind: ReplayKind) => void;
  push: () => void;
  search: () => void;
  closeFile: () => void;
  showFile: (view: FileView) => void;
  compareWithWorkingCopy: () => void;
  compareWithPick: () => void;
  pick: () => void;
  clearPick: () => void;
  swapCompare: () => void;
  endCompare: () => void;
  toggleHide: () => void;
  toggleSolo: () => void;
  showAllBranches: () => void;
  checkout: () => void;
  newBranch: () => void;
  renameBranch: () => void;
  deleteBranch: () => void;
  tryLocally: () => void;
  removeWorktree: () => void;
  createTag: () => void;
  deleteTag: () => void;
  openRepository: (root: RepositoryRoot) => void;
  jumpToRef: (reference: FullRef) => void;
  showStash: (stash: Stash) => void;
  stageAll: () => void;
  unstageAll: () => void;
  discardAll: () => void;
  stashChanges: () => void;
  focusCommit: () => void;
  undo: () => void;
  redo: () => void;
  writeLines: (action: PartAction) => void;
};

type Shortcut = {
  key: string;
  modifier: "platform" | "cmdOrCtrl" | "unchecked" | "none";
  shift?: true;
  yieldsToTyping?: true;
};

export type ActionId =
  | "stageLines"
  | "unstageLines"
  | "discardLines"
  | "stageAll"
  | "unstageAll"
  | "discardAll"
  | "stashChanges"
  | "focusCommit"
  | "undo"
  | "redo"
  | "fetch"
  | "fetchAll"
  | "mergeUpstream"
  | "mergeBranch"
  | "fastForward"
  | "pullFastForwardIfPossible"
  | "pullFastForwardOnly"
  | "pullRebase"
  | "push"
  | "search"
  | "closeFile"
  | "unifiedDiff"
  | "splitDiff"
  | "fileHistory"
  | "blame"
  | "compareWithWorkingCopy"
  | "compareWithPick"
  | "pick"
  | "clearPick"
  | "swapCompare"
  | "endCompare"
  | "toggleHide"
  | "toggleSolo"
  | "showAllBranches"
  | "checkout"
  | "newBranch"
  | "renameBranch"
  | "deleteBranch"
  | "tryLocally"
  | "removeWorktree"
  | "createTag"
  | "deleteTag"
  | "cherryPick"
  | "revert"
  | "addRepository"
  | "showPullRequests"
  | "showHistory"
  | "searchPullRequests"
  | "closePullRequest"
  | "nextFile"
  | "previousFile"
  | "nextChange"
  | "previousChange"
  | "toggleViewed"
  | "toggleSidebar"
  | "toggleInspector"
  | "openSettings"
  | `${SettingsSection}Settings`
  | "leaveSettings";

type Action = {
  id: ActionId;
  title: string | ((context: ActionContext) => string);
  /** What the action would do, or why it is unavailable. */
  detail?: (context: ActionContext) => string;
  shortcut?: Shortcut;
  /** Whether a key that is held down runs it once. */
  once?: true;
  available: (context: ActionContext) => boolean;
  run: (commands: Commands) => void;
};

const onRepository = (context: ActionContext) =>
  context.screen === "repository";
const onPullRequests = (context: ActionContext) =>
  context.screen === "pullRequests";
const onPullRequestList = (context: ActionContext) =>
  onPullRequests(context) && !context.pullRequestOpen && !context.dialogOpen;
const onPullRequest = (context: ActionContext) =>
  onPullRequests(context) && context.pullRequestOpen;
const onFilesChanged = (context: ActionContext) =>
  onPullRequest(context) &&
  context.filesChanged !== null &&
  !context.dialogOpen &&
  !context.menuOpen;
const outsideSettings = (context: ActionContext) =>
  context.screen !== "settings";
const keysFree = (context: ActionContext) =>
  onRepository(context) && !context.adding;
const writable = (context: ActionContext) =>
  onRepository(context) && !context.writing && !context.merging;
const fileOpen = (context: ActionContext) =>
  onRepository(context) && context.file !== null;
const withRevision = (context: ActionContext) =>
  onRepository(context) && context.file?.hasCommit === true;
const replayable = (context: ActionContext) =>
  onRepository(context) &&
  context.replay !== null &&
  context.selection?.kind === "commit";
const linesAllow = (action: PartAction) => (context: ActionContext) =>
  onRepository(context) &&
  !context.writing &&
  context.file?.lineActions.includes(action) === true;
const pullDetail =
  (diverged: (upstream: string) => string) => (context: ActionContext) =>
    context.pull.kind === "ready"
      ? `Fetch ${context.pull.upstream}, then fast-forward ${context.pull.name}${diverged(context.pull.upstream)}`
      : context.pull.reason;
const branchName = (context: ActionContext) =>
  context.sidebarBranch?.name ?? "";

export const PALETTE_SHORTCUT: Shortcut = { key: "p", modifier: "platform" };
const UNDO_SHORTCUT: Shortcut = {
  key: "z",
  modifier: "platform",
  yieldsToTyping: true,
};
const letter = (key: string): Shortcut => ({
  key,
  modifier: "none",
  yieldsToTyping: true,
});
const REDO_SHORTCUT: Shortcut = { ...UNDO_SHORTCUT, shift: true };

export const actions: readonly Action[] = [
  {
    id: "stageLines",
    title: "Stage chosen lines",
    available: linesAllow("stage"),
    run: (commands) => commands.writeLines("stage"),
  },
  {
    id: "unstageLines",
    title: "Unstage chosen lines",
    available: linesAllow("unstage"),
    run: (commands) => commands.writeLines("unstage"),
  },
  {
    id: "discardLines",
    title: "Discard chosen lines…",
    available: linesAllow("discard"),
    run: (commands) => commands.writeLines("discard"),
  },
  {
    id: "stageAll",
    title: "Stage all",
    available: (context) =>
      onRepository(context) &&
      !context.writing &&
      (context.worktree?.unstaged ?? 0) > 0,
    run: (commands) => commands.stageAll(),
  },
  {
    id: "unstageAll",
    title: "Unstage all",
    available: (context) =>
      onRepository(context) &&
      !context.writing &&
      (context.worktree?.staged ?? 0) > 0,
    run: (commands) => commands.unstageAll(),
  },
  {
    id: "discardAll",
    title: "Discard all changes…",
    available: (context) =>
      writable(context) && (context.worktree?.discardable ?? 0) > 0,
    run: (commands) => commands.discardAll(),
  },
  {
    id: "stashChanges",
    title: "Stash changes…",
    available: (context) =>
      writable(context) &&
      (context.worktree?.unstaged ?? 0) +
        (context.worktree?.staged ?? 0) +
        (context.worktree?.conflicts ?? 0) >
        0,
    run: (commands) => commands.stashChanges(),
  },
  {
    id: "focusCommit",
    title: "Commit…",
    available: (context) =>
      writable(context) && (context.worktree?.staged ?? 0) > 0,
    run: (commands) => commands.focusCommit(),
  },
  {
    id: "undo",
    title: (context) => `Undo ${context.history.undo ?? ""}`,
    shortcut: UNDO_SHORTCUT,
    available: (context) =>
      keysFree(context) &&
      !context.dialogOpen &&
      !context.writing &&
      context.history.undo !== null,
    run: (commands) => commands.undo(),
  },
  {
    id: "redo",
    title: (context) => `Redo ${context.history.redo ?? ""}`,
    shortcut: REDO_SHORTCUT,
    available: (context) =>
      keysFree(context) &&
      !context.dialogOpen &&
      !context.writing &&
      context.history.redo !== null,
    run: (commands) => commands.redo(),
  },
  {
    id: "fetch",
    title: "Fetch",
    detail: (context) => {
      const target = context.repository?.fetch;
      if (target?.kind === "ready") return target.detail;
      return target?.reason ?? "Checking the current repository…";
    },
    available: (context) =>
      onRepository(context) &&
      context.repository !== null &&
      !context.repository.fetching &&
      context.repository.fetch.kind === "ready",
    run: (commands) => commands.fetch(),
  },
  {
    id: "fetchAll",
    title: "Fetch all",
    detail: () => "Fetch every remote of this repository.",
    available: (context) =>
      onRepository(context) &&
      context.repository !== null &&
      !context.repository.fetching,
    run: (commands) => commands.fetchAll(),
  },
  {
    id: "mergeBranch",
    title: "Merge selected branch into current branch…",
    available: (context) => writable(context) && context.selectedMergeAvailable,
    run: (commands) => commands.mergeBranch(),
  },
  {
    id: "mergeUpstream",
    title: "Merge upstream…",
    available: (context) =>
      onRepository(context) && !context.writing && context.mergeAvailable,
    run: (commands) => commands.mergeUpstream(),
  },
  {
    id: "pullFastForwardIfPossible",
    title: "Pull (Fast-forward if possible)",
    detail: pullDetail(() => ", or review a merge if it has diverged."),
    available: (context) =>
      onRepository(context) && context.pull.kind === "ready",
    run: (commands) => commands.pullFastForwardIfPossible(),
  },
  {
    id: "pullFastForwardOnly",
    title: "Pull (Fast-forward only)",
    detail: pullDetail(() => ". Nothing changes if it has diverged."),
    available: (context) =>
      onRepository(context) && context.pull.kind === "ready",
    run: (commands) => commands.pullFastForwardOnly(),
  },
  {
    id: "pullRebase",
    title: "Pull (Rebase)",
    detail: pullDetail(
      (upstream) => `, or rebase it onto ${upstream} if it has diverged.`,
    ),
    available: (context) =>
      onRepository(context) && context.pull.kind === "ready",
    run: (commands) => commands.pullRebase(),
  },
  {
    id: "fastForward",
    title: (context) =>
      `Fast-forward all branches (${context.repository?.ready ?? 0})`,
    available: (context) =>
      onRepository(context) &&
      context.repository !== null &&
      context.repository.idle &&
      context.repository.ready > 0,
    run: (commands) => commands.fastForward(),
  },
  {
    id: "push",
    title: (context) => context.push?.label ?? "Push",
    detail: (context) => context.push?.title ?? "Push",
    available: (context) =>
      onRepository(context) &&
      !context.writing &&
      (context.push?.kind === "ready" || context.push?.kind === "publish"),
    run: (commands) => commands.push(),
  },
  {
    id: "search",
    title: "Search history",
    shortcut: { key: "f", modifier: "platform" },
    available: (context) =>
      keysFree(context) && context.file === null && context.searchable,
    run: (commands) => commands.search(),
  },
  {
    id: "closeFile",
    title: "Back to history",
    shortcut: { key: "Escape", modifier: "unchecked" },
    available: (context) =>
      keysFree(context) && !context.dialogOpen && context.file !== null,
    run: (commands) => commands.closeFile(),
  },
  {
    id: "unifiedDiff",
    title: "Show unified diff",
    available: fileOpen,
    run: (commands) => commands.showFile("unified"),
  },
  {
    id: "splitDiff",
    title: "Show split diff",
    available: fileOpen,
    run: (commands) => commands.showFile("split"),
  },
  {
    id: "fileHistory",
    title: "Show file history",
    available: withRevision,
    run: (commands) => commands.showFile("history"),
  },
  {
    id: "blame",
    title: "Show blame",
    available: withRevision,
    run: (commands) => commands.showFile("blame"),
  },
  {
    id: "compareWithWorkingCopy",
    title: "Compare with working copy",
    available: (context) =>
      onRepository(context) && context.selection?.kind === "commit",
    run: (commands) => commands.compareWithWorkingCopy(),
  },
  {
    id: "compareWithPick",
    title: (context) =>
      `Compare with ${context.picked === null ? "" : shortOid(context.picked)}`,
    available: (context) =>
      onRepository(context) &&
      context.picked !== null &&
      context.selection?.kind === "commit" &&
      context.selection.oid !== context.picked,
    run: (commands) => commands.compareWithPick(),
  },
  {
    id: "pick",
    title: "Pick for comparison",
    available: (context) =>
      onRepository(context) &&
      context.selection?.kind === "commit" &&
      context.selection.oid !== context.picked,
    run: (commands) => commands.pick(),
  },
  {
    id: "clearPick",
    title: "Clear pick",
    available: (context) => onRepository(context) && context.picked !== null,
    run: (commands) => commands.clearPick(),
  },
  {
    id: "swapCompare",
    title: "Swap compared commits",
    available: (context) =>
      onRepository(context) && context.compare?.swappable === true,
    run: (commands) => commands.swapCompare(),
  },
  {
    id: "endCompare",
    title: "Stop comparing",
    available: (context) => onRepository(context) && context.compare !== null,
    run: (commands) => commands.endCompare(),
  },
  {
    id: "toggleHide",
    title: (context) =>
      `${context.sidebarBranch?.visibility === "hidden" || context.sidebarBranch?.outOfView ? "Show" : "Hide"} ${branchName(context)}`,
    available: (context) =>
      onRepository(context) && context.sidebarBranch !== null,
    run: (commands) => commands.toggleHide(),
  },
  {
    id: "toggleSolo",
    title: (context) =>
      `${context.sidebarBranch?.visibility === "soloed" ? "Stop soloing" : "Solo"} ${branchName(context)}`,
    available: (context) =>
      onRepository(context) &&
      context.sidebarBranch !== null &&
      !(context.sidebarBranch.outOfView && context.rule === "solo"),
    run: (commands) => commands.toggleSolo(),
  },
  {
    id: "showAllBranches",
    title: "Show all branches",
    available: (context) => onRepository(context) && context.rule !== "none",
    run: (commands) => commands.showAllBranches(),
  },
  {
    id: "checkout",
    title: (context) => `Check out ${branchName(context)}`,
    available: (context) =>
      writable(context) &&
      context.sidebarBranch !== null &&
      !context.sidebarBranch.checkedOut,
    run: (commands) => commands.checkout(),
  },
  {
    id: "newBranch",
    title: (context) => `New branch from ${branchName(context)}…`,
    available: (context) => writable(context) && context.sidebarBranch !== null,
    run: (commands) => commands.newBranch(),
  },
  {
    id: "renameBranch",
    title: (context) => `Rename ${branchName(context)}…`,
    available: (context) =>
      writable(context) && context.sidebarBranch?.local === true,
    run: (commands) => commands.renameBranch(),
  },
  {
    id: "deleteBranch",
    title: (context) => `Delete ${branchName(context)}…`,
    available: (context) =>
      writable(context) &&
      context.sidebarBranch?.local === true &&
      !context.sidebarBranch.checkedOut,
    run: (commands) => commands.deleteBranch(),
  },
  {
    id: "tryLocally",
    title: (context) => `Try ${branchName(context)} locally…`,
    available: (context) =>
      writable(context) &&
      context.sidebarBranch !== null &&
      !(context.sidebarBranch.local && context.sidebarBranch.checkedOut),
    run: (commands) => commands.tryLocally(),
  },
  {
    id: "removeWorktree",
    title: (context) =>
      `Remove worktree ${context.sidebarBranch?.removableWorktree ?? ""}…`,
    available: (context) =>
      writable(context) && context.sidebarBranch?.removableWorktree != null,
    run: (commands) => commands.removeWorktree(),
  },
  {
    id: "createTag",
    title: "Create tag…",
    available: (context) =>
      writable(context) && context.selection?.kind === "commit",
    run: (commands) => commands.createTag(),
  },
  {
    id: "deleteTag",
    title: (context) => `Delete tag ${context.sidebarTag?.name ?? ""}…`,
    available: (context) => writable(context) && context.sidebarTag !== null,
    run: (commands) => commands.deleteTag(),
  },
  {
    id: "cherryPick",
    title: (context) =>
      replayEntry("cherryPick", context.replay?.branch ?? null),
    available: replayable,
    run: (commands) => commands.replay("cherryPick"),
  },
  {
    id: "revert",
    title: (context) => replayEntry("revert", context.replay?.branch ?? null),
    available: replayable,
    run: (commands) => commands.replay("revert"),
  },
  {
    id: "addRepository",
    title: "Add repository",
    shortcut: { key: "o", modifier: "cmdOrCtrl" },
    available: onRepository,
    run: (commands) => commands.addRepository(),
  },
  {
    id: "showPullRequests",
    title: "Show pull requests",
    available: onRepository,
    run: (commands) => commands.showPullRequests(),
  },
  {
    id: "closePullRequest",
    title: "Back to pull requests",
    shortcut: { key: "Escape", modifier: "unchecked", yieldsToTyping: true },
    available: (context) => onPullRequest(context) && !context.dialogOpen,
    run: (commands) => commands.closePullRequest(),
  },
  {
    id: "nextFile",
    title: "Next file",
    shortcut: letter("j"),
    available: (context) => {
      const place = context.filesChanged;
      return (
        onFilesChanged(context) && place !== null && place.at + 1 < place.count
      );
    },
    run: (commands) => commands.nextFile(),
  },
  {
    id: "previousFile",
    title: "Previous file",
    shortcut: letter("k"),
    available: (context) =>
      onFilesChanged(context) && (context.filesChanged?.at ?? 0) > 0,
    run: (commands) => commands.previousFile(),
  },
  {
    id: "nextChange",
    title: "Next change",
    shortcut: letter("n"),
    available: onFilesChanged,
    run: (commands) => commands.nextChange(),
  },
  {
    id: "previousChange",
    title: "Previous change",
    shortcut: letter("p"),
    available: onFilesChanged,
    run: (commands) => commands.previousChange(),
  },
  {
    id: "toggleViewed",
    title: (context) =>
      context.filesChanged?.isViewed === true
        ? "Mark file unviewed"
        : "Mark file viewed",
    shortcut: letter("v"),
    once: true,
    available: onFilesChanged,
    run: (commands) => commands.toggleViewed(),
  },
  {
    id: "showHistory",
    title: "Back to history",
    shortcut: { key: "Escape", modifier: "unchecked", yieldsToTyping: true },
    available: onPullRequestList,
    run: (commands) => commands.showHistory(),
  },
  {
    id: "searchPullRequests",
    title: "Search pull requests",
    shortcut: { key: "f", modifier: "platform" },
    available: onPullRequestList,
    run: (commands) => commands.searchPullRequests(),
  },
  {
    id: "toggleSidebar",
    title: "Toggle sidebar",
    available: () => true,
    run: (commands) => commands.toggleSidebar(),
  },
  {
    id: "toggleInspector",
    title: (context) =>
      onPullRequest(context)
        ? "Toggle pull request details"
        : "Toggle commit inspector",
    available: (context) =>
      onPullRequest(context) || (onRepository(context) && context.inspectable),
    run: (commands) => commands.toggleInspector(),
  },
  {
    id: "openSettings",
    title: "Open Settings",
    available: outsideSettings,
    run: (commands) => commands.openSettings(),
  },
  ...settingsSections.map(
    ({ id, label }): Action => ({
      id: `${id}Settings`,
      title: `Open ${label} settings`,
      available: (context) =>
        outsideSettings(context) || context.section !== id,
      run: (commands) => commands.openSettings(id),
    }),
  ),
  {
    id: "leaveSettings",
    title: (context) =>
      context.place === "repository"
        ? "Back to repository"
        : "Back to pull requests",
    shortcut: { key: "Escape", modifier: "unchecked" },
    available: (context) =>
      context.screen === "settings" && !context.dialogOpen,
    run: (commands) => commands.leaveSettings(),
  },
];

function availableActions(context: ActionContext): Action[] {
  return actions.filter((action) => action.available(context));
}

export function titleOf(action: Action, context: ActionContext): string {
  return typeof action.title === "string"
    ? action.title
    : action.title(context);
}

type Key = Pick<
  KeyboardEvent,
  "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey"
>;

export function matchesShortcut(
  shortcut: Shortcut,
  event: Key,
  mac: boolean,
): boolean {
  if (event.key.toLowerCase() !== shortcut.key.toLowerCase()) return false;
  if (shortcut.modifier === "unchecked") return true;
  if (shortcut.modifier === "cmdOrCtrl") return event.metaKey || event.ctrlKey;
  if (shortcut.modifier === "none")
    return !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);
  return (
    (mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) &&
    event.shiftKey === (shortcut.shift === true) &&
    !event.altKey
  );
}

export function shortcutAction(
  context: ActionContext,
  event: Key,
  mac: boolean,
): Action | null {
  return (
    actions.find(
      (action) =>
        action.shortcut !== undefined &&
        !(action.shortcut.yieldsToTyping && context.typing) &&
        matchesShortcut(action.shortcut, event, mac) &&
        action.available(context),
    ) ?? null
  );
}

export function claimedWhilePaletteOpen(event: Key, mac: boolean): boolean {
  return actions.some(
    ({ shortcut }) =>
      shortcut !== undefined &&
      shortcut.modifier !== "unchecked" &&
      !shortcut.yieldsToTyping &&
      matchesShortcut(shortcut, event, mac),
  );
}

const TEXT_INPUTS = new Set(["text", "search", "url", "email", "password"]);

export function typingIn(
  target: {
    tagName: string;
    type?: string;
    isContentEditable?: boolean;
  } | null,
): boolean {
  if (target === null) return false;
  return (
    target.isContentEditable === true ||
    target.tagName === "TEXTAREA" ||
    (target.tagName === "INPUT" && TEXT_INPUTS.has(target.type ?? "text"))
  );
}

function shortcutLabel(shortcut: Shortcut, mac: boolean): string {
  if (shortcut.modifier === "unchecked")
    return shortcut.key === "Escape" ? "Esc" : shortcut.key;
  const key = shortcut.key.toUpperCase();
  if (shortcut.modifier === "none") return key;
  if (mac) return `${shortcut.shift ? "⇧" : ""}⌘${key}`;
  return `Ctrl+${shortcut.shift ? "Shift+" : ""}${key}`;
}

type PaletteKind = "action" | "repository" | "branch" | "tag" | "stash";

export type PaletteItem = {
  id: string;
  kind: PaletteKind;
  title: string;
  detail?: string;
  /** Other names the search matches, ranked after the title. */
  aliases?: readonly string[];
  shortcut?: string;
  disabled?: boolean;
  run: () => void;
};

type NamedRef = { reference: FullRef; name: string };

export function paletteItems(
  context: ActionContext,
  commands: Commands,
  mac: boolean,
  repositories: readonly { root: RepositoryRoot; name: string }[],
  refs: {
    branches: readonly NamedRef[];
    tags: readonly NamedRef[];
    stashes: readonly Stash[];
  } | null,
): PaletteItem[] {
  const listed: PaletteItem[] = availableActions(context).map((action) => ({
    id: `action:${action.id}`,
    kind: "action",
    title: titleOf(action, context),
    detail: action.detail?.(context),
    shortcut: action.shortcut && shortcutLabel(action.shortcut, mac),
    run: () => action.run(commands),
  }));
  if (!onRepository(context)) return listed;
  if (context.push?.kind === "disabled")
    listed.push({
      id: "action:push",
      kind: "action",
      title: context.push.label,
      detail: context.push.title,
      disabled: true,
      run: () => {},
    });
  const suffixes = distinctNames(repositories);
  return [
    ...listed,
    ...repositories.map(
      (repository): PaletteItem => ({
        id: `repository:${repository.root}`,
        kind: "repository",
        title: suffixes.has(repository.root)
          ? `${repository.name} (${suffixes.get(repository.root)})`
          : repository.name,
        detail: repository.root,
        run: () => commands.openRepository(repository.root),
      }),
    ),
    ...(refs?.branches ?? []).map(
      (branch): PaletteItem => ({
        id: `branch:${branch.reference}`,
        kind: "branch",
        title: branch.name,
        run: () => commands.jumpToRef(branch.reference),
      }),
    ),
    ...(refs?.tags ?? []).map(
      (tag): PaletteItem => ({
        id: `tag:${tag.reference}`,
        kind: "tag",
        title: tag.name,
        run: () => commands.jumpToRef(tag.reference),
      }),
    ),
    ...(refs?.stashes ?? []).map(
      (stash): PaletteItem => ({
        id: `stash:${stash.name}`,
        kind: "stash",
        title: stash.message,
        detail: stash.name,
        aliases: [stash.name],
        run: () => commands.showStash(stash),
      }),
    ),
  ];
}

const WORD = /[\p{L}\p{N}]/u;
const PREFIX = 0;
const WORD_START = 1;
const SUBSTRING = 2;
const IN_ORDER = 3;

function rank(title: string, query: string): number | null {
  const text = normalizeSearch(title);
  let at = text.indexOf(query);
  if (at === 0) return PREFIX;
  if (at > 0) {
    for (; at > 0; at = text.indexOf(query, at + 1))
      if (!WORD.test(text.charAt(at - 1))) return WORD_START;
    return SUBSTRING;
  }
  let first = -1;
  let next = 0;
  for (const char of query) {
    const found = text.indexOf(char, next);
    if (found < 0) return null;
    if (first < 0) first = found;
    next = found + char.length;
  }
  return IN_ORDER + (next - first) / (text.length + 1);
}

const KIND_ORDER: Record<PaletteKind, number> = {
  action: 0,
  repository: 1,
  branch: 2,
  tag: 3,
  stash: 4,
};

export function filterPalette(
  items: readonly PaletteItem[],
  query: string,
): readonly PaletteItem[] {
  const needle = normalizeSearch(query.trim());
  if (needle === "") return items;
  const ranked: { item: PaletteItem; score: number; index: number }[] = [];
  items.forEach((item, index) => {
    const scores = [item.title, ...(item.aliases ?? [])].flatMap(
      (name, position) => {
        const score = rank(name, needle);
        return score === null ? [] : [score + position * 0.5];
      },
    );
    if (scores.length > 0)
      ranked.push({ item, score: Math.min(...scores), index });
  });
  ranked.sort(
    (left, right) =>
      left.score - right.score ||
      KIND_ORDER[left.item.kind] - KIND_ORDER[right.item.kind] ||
      left.index - right.index,
  );
  return ranked.map(({ item }) => item);
}
