import type { PushControl } from "./domain/push";
import { normalizeSearch } from "./domain/search";
import type { FullRef, Oid, RepositoryRoot, Stash } from "./domain/repository";
import type { Selection } from "./domain/selection";
import type { PartAction } from "./domain/operations";
import type { BranchVisibility, VisibilityRule } from "./domain/visibility";

export type Screen = "repository" | "settings";
export type SettingsSection = "general" | "appearance";
export type FileView = "unified" | "split" | "history" | "blame";

export type ActionContext = {
  screen: Screen;
  section: SettingsSection;
  dialogOpen: boolean;
  adding: boolean;
  searchable: boolean;
  inspectable: boolean;
  push: PushControl | null;
  repository: { fetching: boolean; idle: boolean; ready: number } | null;
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
  typing: boolean;
};

export type Commands = {
  addRepository: () => void;
  openSettings: (section?: SettingsSection) => void;
  leaveSettings: () => void;
  toggleSidebar: () => void;
  toggleInspector: () => void;
  fetch: () => void;
  fastForward: () => void;
  mergeUpstream: () => void;
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

export type Shortcut = {
  key: string;
  modifier: "platform" | "cmdOrCtrl" | "unchecked";
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
  | "mergeUpstream"
  | "fastForward"
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
  | "createTag"
  | "deleteTag"
  | "addRepository"
  | "toggleSidebar"
  | "toggleInspector"
  | "openSettings"
  | "appearanceSettings"
  | "generalSettings"
  | "leaveSettings";

export type Action = {
  id: ActionId;
  title: string | ((context: ActionContext) => string);
  shortcut?: Shortcut;
  available: (context: ActionContext) => boolean;
  run: (commands: Commands) => void;
};

const onRepository = (context: ActionContext) =>
  context.screen === "repository";
const keysFree = (context: ActionContext) =>
  onRepository(context) && !context.adding;
const fileOpen = (context: ActionContext) =>
  onRepository(context) && context.file !== null;
const withRevision = (context: ActionContext) =>
  onRepository(context) && context.file?.hasCommit === true;
const linesAllow = (action: PartAction) => (context: ActionContext) =>
  onRepository(context) &&
  !context.writing &&
  context.file?.lineActions.includes(action) === true;
const branchName = (context: ActionContext) =>
  context.sidebarBranch?.name ?? "";

export const PALETTE_SHORTCUT: Shortcut = { key: "p", modifier: "platform" };
export const UNDO_SHORTCUT: Shortcut = {
  key: "z",
  modifier: "platform",
  yieldsToTyping: true,
};
export const REDO_SHORTCUT: Shortcut = { ...UNDO_SHORTCUT, shift: true };

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
      onRepository(context) &&
      !context.writing &&
      !context.merging &&
      (context.worktree?.discardable ?? 0) > 0,
    run: (commands) => commands.discardAll(),
  },
  {
    id: "stashChanges",
    title: "Stash changes…",
    available: (context) =>
      onRepository(context) &&
      !context.writing &&
      !context.merging &&
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
      onRepository(context) &&
      !context.writing &&
      !context.merging &&
      (context.worktree?.staged ?? 0) > 0,
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
    available: (context) =>
      onRepository(context) &&
      context.repository !== null &&
      !context.repository.fetching,
    run: (commands) => commands.fetch(),
  },
  {
    id: "mergeUpstream",
    title: "Merge upstream…",
    available: (context) =>
      onRepository(context) &&
      !context.writing &&
      context.mergeAvailable === true,
    run: (commands) => commands.mergeUpstream(),
  },
  {
    id: "fastForward",
    title: (context) => `Fast-forward (${context.repository?.ready ?? 0})`,
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
    title: (context) => `Compare with ${context.picked?.slice(0, 7) ?? ""}`,
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
      onRepository(context) &&
      !context.writing &&
      !context.merging &&
      context.sidebarBranch !== null &&
      !context.sidebarBranch.checkedOut,
    run: (commands) => commands.checkout(),
  },
  {
    id: "newBranch",
    title: (context) => `New branch from ${branchName(context)}…`,
    available: (context) =>
      onRepository(context) &&
      !context.writing &&
      !context.merging &&
      context.sidebarBranch !== null,
    run: (commands) => commands.newBranch(),
  },
  {
    id: "renameBranch",
    title: (context) => `Rename ${branchName(context)}…`,
    available: (context) =>
      onRepository(context) &&
      !context.writing &&
      !context.merging &&
      context.sidebarBranch?.local === true,
    run: (commands) => commands.renameBranch(),
  },
  {
    id: "deleteBranch",
    title: (context) => `Delete ${branchName(context)}…`,
    available: (context) =>
      onRepository(context) &&
      !context.writing &&
      !context.merging &&
      context.sidebarBranch?.local === true &&
      !context.sidebarBranch.checkedOut,
    run: (commands) => commands.deleteBranch(),
  },
  {
    id: "createTag",
    title: "Create tag…",
    available: (context) =>
      onRepository(context) &&
      !context.writing &&
      !context.merging &&
      context.selection?.kind === "commit",
    run: (commands) => commands.createTag(),
  },
  {
    id: "deleteTag",
    title: (context) => `Delete tag ${context.sidebarTag?.name ?? ""}…`,
    available: (context) =>
      onRepository(context) &&
      !context.writing &&
      !context.merging &&
      context.sidebarTag !== null,
    run: (commands) => commands.deleteTag(),
  },
  {
    id: "addRepository",
    title: "Add repository",
    shortcut: { key: "o", modifier: "cmdOrCtrl" },
    available: onRepository,
    run: (commands) => commands.addRepository(),
  },
  {
    id: "toggleSidebar",
    title: "Toggle sidebar",
    available: () => true,
    run: (commands) => commands.toggleSidebar(),
  },
  {
    id: "toggleInspector",
    title: "Toggle commit inspector",
    available: (context) => onRepository(context) && context.inspectable,
    run: (commands) => commands.toggleInspector(),
  },
  {
    id: "openSettings",
    title: "Open Settings",
    available: onRepository,
    run: (commands) => commands.openSettings(),
  },
  {
    id: "appearanceSettings",
    title: "Open Appearance settings",
    available: (context) =>
      onRepository(context) || context.section !== "appearance",
    run: (commands) => commands.openSettings("appearance"),
  },
  {
    id: "generalSettings",
    title: "Open General settings",
    available: (context) =>
      onRepository(context) || context.section !== "general",
    run: (commands) => commands.openSettings("general"),
  },
  {
    id: "leaveSettings",
    title: "Back to repository",
    shortcut: { key: "Escape", modifier: "unchecked" },
    available: (context) =>
      context.screen === "settings" && !context.dialogOpen,
    run: (commands) => commands.leaveSettings(),
  },
];

export function availableActions(context: ActionContext): Action[] {
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

export function shortcutLabel(shortcut: Shortcut, mac: boolean): string {
  if (shortcut.modifier === "unchecked")
    return shortcut.key === "Escape" ? "Esc" : shortcut.key;
  const key = shortcut.key.toUpperCase();
  if (mac) return `${shortcut.shift ? "⇧" : ""}⌘${key}`;
  return `Ctrl+${shortcut.shift ? "Shift+" : ""}${key}`;
}

export type PaletteKind = "action" | "repository" | "branch" | "tag" | "stash";

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
  return [
    ...listed,
    ...repositories.map(
      (repository): PaletteItem => ({
        id: `repository:${repository.root}`,
        kind: "repository",
        title: repository.name,
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
