import { describe, expect, it, vi } from "vitest";
import {
  claimedWhilePaletteOpen,
  filterPalette,
  matchesShortcut,
  PALETTE_SHORTCUT,
  paletteItems,
  shortcutAction,
  typingIn,
} from "./actions";
import type { ActionContext, Commands } from "./actions";
import type { FullRef, Oid, RepositoryRoot } from "./domain/repository";

const repositoryScreen: ActionContext = {
  screen: "repository",
  section: "appearance",
  dialogOpen: false,
  adding: false,
  searchable: true,
  inspectable: true,
  repository: { fetching: false, idle: true, ready: 0 },
  file: null,
  selection: null,
  picked: null,
  compare: null,
  sidebarBranch: null,
  rule: "none",
  worktree: null,
  history: { undo: null, redo: null },
  writing: false,
  typing: false,
};

function commands(): Commands {
  return {
    addRepository: vi.fn(),
    openSettings: vi.fn(),
    leaveSettings: vi.fn(),
    toggleSidebar: vi.fn(),
    toggleInspector: vi.fn(),
    fetch: vi.fn(),
    fastForward: vi.fn(),
    search: vi.fn(),
    closeFile: vi.fn(),
    showFile: vi.fn(),
    compareWithWorkingCopy: vi.fn(),
    compareWithPick: vi.fn(),
    pick: vi.fn(),
    clearPick: vi.fn(),
    swapCompare: vi.fn(),
    endCompare: vi.fn(),
    toggleHide: vi.fn(),
    toggleSolo: vi.fn(),
    showAllBranches: vi.fn(),
    openRepository: vi.fn(),
    jumpToRef: vi.fn(),
    showStash: vi.fn(),
    stageAll: vi.fn(),
    unstageAll: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
  };
}

const repositories = [
  { root: "/work/l1-demo" as RepositoryRoot, name: "l1-demo" },
  { root: "/work/sync" as RepositoryRoot, name: "sync" },
];
const stash = {
  name: "stash@{0}",
  oid: "c".repeat(40) as Oid,
  message: "On main: try a retry",
  timestamp: 0,
};
const branches = [
  { reference: "refs/heads/main" as FullRef, name: "main" },
  {
    reference: "refs/heads/feature/fetch-retry" as FullRef,
    name: "feature/fetch-retry",
  },
  {
    reference: "refs/remotes/origin/main" as FullRef,
    name: "origin/main",
  },
];

const refs = {
  branches,
  tags: [{ reference: "refs/tags/v1.0.0" as FullRef, name: "v1.0.0" }],
  stashes: [stash],
};

function titles(context: ActionContext, query: string, mac = true) {
  return filterPalette(
    paletteItems(context, commands(), mac, repositories, {
      branches,
      tags: [],
      stashes: [],
    }),
    query,
  ).map((item) => item.title);
}

const key = (
  key: string,
  modifiers: Partial<
    Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "shiftKey" | "altKey">
  > = {},
) => ({
  key,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...modifiers,
});

describe("command palette", () => {
  it("ranks a prefix, then word starts, then letters in order", () => {
    expect(titles(repositoryScreen, "fetch")).toEqual([
      "Fetch",
      "Open Fetching settings",
      "feature/fetch-retry",
    ]);
    expect(titles(repositoryScreen, "main")).toEqual(["main", "origin/main"]);
    expect(titles(repositoryScreen, "sync")).toEqual(["sync"]);
    expect(titles(repositoryScreen, "tgsb")).toEqual(["Toggle sidebar"]);
  });

  it("folds case and accents and says nothing for no match", () => {
    expect(titles(repositoryScreen, "  FETCH ")[0]).toBe("Fetch");
    expect(titles(repositoryScreen, "zzzz")).toEqual([]);
  });

  it("lists actions, then repositories, then branches when empty", () => {
    expect(titles(repositoryScreen, "")).toEqual([
      "Fetch",
      "Search history",
      "Add repository",
      "Toggle sidebar",
      "Toggle commit inspector",
      "Open Settings",
      "Open Appearance settings",
      "Open Fetching settings",
      "l1-demo",
      "sync",
      "main",
      "feature/fetch-retry",
      "origin/main",
    ]);
  });

  it("leaves repository actions, repositories, and branches off Settings", () => {
    const settings: ActionContext = { ...repositoryScreen, screen: "settings" };
    expect(titles(settings, "")).toEqual([
      "Toggle sidebar",
      "Open Fetching settings",
      "Back to repository",
    ]);
    expect(titles(settings, "fetch")).toEqual(["Open Fetching settings"]);
    expect(titles({ ...settings, section: "fetching" }, "settings")).toEqual([
      "Open Appearance settings",
    ]);
  });

  it("offers selection and comparison actions only when they apply", () => {
    const comparing: ActionContext = {
      ...repositoryScreen,
      repository: { fetching: true, idle: false, ready: 2 },
      selection: { kind: "commit", oid: "a".repeat(40) as Oid },
      compare: { swappable: true },
      file: { hasCommit: false },
      sidebarBranch: {
        name: "feature/fetch-retry",
        visibility: "hidden",
        outOfView: false,
      },
      rule: "hide",
    };
    expect(titles(comparing, "")).toEqual([
      "Back to history",
      "Show unified diff",
      "Show split diff",
      "Compare with working copy",
      "Pick for comparison",
      "Swap compared commits",
      "Stop comparing",
      "Show feature/fetch-retry",
      "Solo feature/fetch-retry",
      "Show all branches",
      "Add repository",
      "Toggle sidebar",
      "Toggle commit inspector",
      "Open Settings",
      "Open Appearance settings",
      "Open Fetching settings",
      "l1-demo",
      "sync",
      "main",
      "feature/fetch-retry",
      "origin/main",
    ]);
    const ready: ActionContext = {
      ...repositoryScreen,
      repository: { fetching: false, idle: true, ready: 1 },
      file: { hasCommit: true },
      sidebarBranch: { name: "main", visibility: "soloed", outOfView: false },
      rule: "solo",
    };
    expect(titles(ready, "o")).toContain("Fast-forward (1)");
    expect(titles(ready, "show")).toEqual([
      "Show unified diff",
      "Show split diff",
      "Show file history",
      "Show blame",
      "Show all branches",
    ]);
    expect(titles(ready, "solo")).toEqual([
      "Stop soloing main",
      "Show file history",
    ]);
  });

  it("only shows a branch whose hidden notice is up", () => {
    const notice = (rule: ActionContext["rule"]): ActionContext => ({
      ...repositoryScreen,
      sidebarBranch: {
        name: "feature/fetch-retry",
        visibility: rule === "hide" ? "hidden" : "shown",
        outOfView: true,
      },
      rule,
    });
    expect(titles(notice("hide"), "feature/fetch-retry")).toEqual([
      "feature/fetch-retry",
      "Show feature/fetch-retry",
      "Solo feature/fetch-retry",
    ]);
    expect(titles(notice("solo"), "feature/fetch-retry")).toEqual([
      "feature/fetch-retry",
      "Show feature/fetch-retry",
    ]);
  });

  it("offers a pick only for another commit", () => {
    const picked = "b".repeat(40) as Oid;
    const other: ActionContext = {
      ...repositoryScreen,
      selection: { kind: "commit", oid: "a".repeat(40) as Oid },
      picked,
    };
    expect(titles(other, "pick")).toEqual([
      "Pick for comparison",
      "Clear pick",
    ]);
    expect(titles(other, "compare with")).toEqual([
      "Compare with working copy",
      "Compare with bbbbbbb",
    ]);
    const same: ActionContext = {
      ...other,
      selection: { kind: "commit", oid: picked },
    };
    expect(titles(same, "pick")).toEqual(["Clear pick"]);
    expect(titles(same, "compare with")).toEqual(["Compare with working copy"]);
    expect(titles({ ...repositoryScreen, picked }, "compare")).toEqual([]);
  });

  it("runs the command an item names", () => {
    const run = commands();
    const items = paletteItems(repositoryScreen, run, true, repositories, refs);
    filterPalette(items, "origin/main")[0]?.run();
    filterPalette(items, "v1.0")[0]?.run();
    filterPalette(items, "try a retry")[0]?.run();
    expect(filterPalette(items, "stash@{0}").map((item) => item.title)).toEqual(
      ["On main: try a retry"],
    );
    filterPalette(items, "sync")[0]?.run();
    filterPalette(items, "fetch")[0]?.run();
    expect(run.jumpToRef).toHaveBeenCalledWith("refs/remotes/origin/main");
    expect(run.jumpToRef).toHaveBeenCalledWith("refs/tags/v1.0.0");
    expect(run.showStash).toHaveBeenCalledWith(stash);
    expect(run.openRepository).toHaveBeenCalledWith("/work/sync");
    expect(run.fetch).toHaveBeenCalledOnce();
  });

  it("labels shortcuts for the platform", () => {
    const items = paletteItems(repositoryScreen, commands(), true, [], null);
    const other = paletteItems(repositoryScreen, commands(), false, [], null);
    const shortcut = (list: typeof items, title: string) =>
      list.find((item) => item.title === title)?.shortcut;
    expect(shortcut(items, "Add repository")).toBe("⌘O");
    expect(shortcut(other, "Search history")).toBe("Ctrl+F");
    expect(
      shortcut(
        paletteItems(
          { ...repositoryScreen, file: { hasCommit: true } },
          commands(),
          true,
          [],
          null,
        ),
        "Back to history",
      ),
    ).toBe("Esc");
  });
});

describe("shortcuts", () => {
  const id = (
    context: ActionContext,
    event: ReturnType<typeof key>,
    mac = true,
  ) => shortcutAction(context, event, mac)?.id ?? null;

  it("opens Add with Cmd or Ctrl and O, even while adding", () => {
    expect(id(repositoryScreen, key("o", { metaKey: true }))).toBe(
      "addRepository",
    );
    expect(
      id(repositoryScreen, key("O", { ctrlKey: true, shiftKey: true })),
    ).toBe("addRepository");
    expect(
      id({ ...repositoryScreen, adding: true }, key("o", { metaKey: true })),
    ).toBe("addRepository");
    expect(
      id(
        { ...repositoryScreen, screen: "settings" },
        key("o", { metaKey: true }),
      ),
    ).toBeNull();
  });

  it("searches with Cmd+F on macOS and Ctrl+F elsewhere", () => {
    expect(id(repositoryScreen, key("f", { metaKey: true }))).toBe("search");
    expect(id(repositoryScreen, key("f", { ctrlKey: true }))).toBeNull();
    expect(id(repositoryScreen, key("f", { ctrlKey: true }), false)).toBe(
      "search",
    );
    expect(id(repositoryScreen, key("f", { metaKey: true }), false)).toBeNull();
    expect(
      id(repositoryScreen, key("f", { metaKey: true, shiftKey: true })),
    ).toBeNull();
    expect(
      id(
        { ...repositoryScreen, file: { hasCommit: true } },
        key("f", { metaKey: true }),
      ),
    ).toBeNull();
    expect(
      id({ ...repositoryScreen, adding: true }, key("f", { metaKey: true })),
    ).toBeNull();
  });

  it("closes a file or leaves Settings with Escape unless a dialog owns it", () => {
    const file: ActionContext = {
      ...repositoryScreen,
      file: { hasCommit: true },
    };
    expect(id(file, key("Escape"))).toBe("closeFile");
    expect(id({ ...file, adding: true }, key("Escape"))).toBeNull();
    expect(id(repositoryScreen, key("Escape"))).toBeNull();
    const settings: ActionContext = { ...repositoryScreen, screen: "settings" };
    expect(id(settings, key("Escape"))).toBe("leaveSettings");
    expect(id({ ...settings, dialogOpen: true }, key("Escape"))).toBeNull();
  });
});

describe("staging and undo", () => {
  const id = (context: ActionContext, event: ReturnType<typeof key>) =>
    shortcutAction(context, event, true)?.id ?? null;
  const history: ActionContext = {
    ...repositoryScreen,
    history: { undo: "Stage README.md", redo: "Unstage 2 files" },
  };

  it("offers Undo and Redo only with an entry, titled with its label", () => {
    expect(titles(repositoryScreen, "undo")).toEqual([]);
    expect(titles(repositoryScreen, "redo")).toEqual([]);
    expect(titles(history, "undo")).toEqual(["Undo Stage README.md"]);
    expect(titles(history, "redo")).toEqual(["Redo Unstage 2 files"]);
    expect(titles({ ...history, writing: true }, "undo")).toEqual([]);
    expect(titles({ ...history, writing: true }, "redo")).toEqual([]);
  });

  it("offers Stage all and Unstage all only for a list with files", () => {
    const unstaged: ActionContext = {
      ...repositoryScreen,
      worktree: { unstaged: 2, staged: 0 },
    };
    expect(titles(unstaged, "stage all")).toEqual(["Stage all"]);
    expect(
      titles({ ...unstaged, worktree: { unstaged: 0, staged: 1 } }, "stage"),
    ).toEqual(["Unstage all"]);
    expect(titles({ ...unstaged, writing: true }, "stage")).toEqual([]);
    expect(titles(repositoryScreen, "stage")).toEqual([]);
  });

  it("undoes with Cmd+Z and redoes with Cmd+Shift+Z", () => {
    expect(id(history, key("z", { metaKey: true }))).toBe("undo");
    expect(id(history, key("Z", { metaKey: true, shiftKey: true }))).toBe(
      "redo",
    );
    expect(
      shortcutAction(history, key("z", { ctrlKey: true }), false)?.id,
    ).toBe("undo");
    expect(id(repositoryScreen, key("z", { metaKey: true }))).toBeNull();
  });

  it("leaves Cmd+Z to a text field, a dialog, or the palette", () => {
    expect(id({ ...history, typing: true }, key("z", { metaKey: true }))).toBe(
      null,
    );
    expect(
      id(
        { ...history, typing: true },
        key("Z", { metaKey: true, shiftKey: true }),
      ),
    ).toBeNull();
    expect(
      id({ ...history, dialogOpen: true }, key("z", { metaKey: true })),
    ).toBeNull();
    expect(claimedWhilePaletteOpen(key("z", { metaKey: true }), true)).toBe(
      false,
    );
  });

  it("labels the redo shortcut with Shift", () => {
    const shortcut = (mac: boolean) =>
      paletteItems(history, commands(), mac, [], null).find(
        (item) => item.title === "Redo Unstage 2 files",
      )?.shortcut;
    expect(shortcut(true)).toBe("⇧⌘Z");
    expect(shortcut(false)).toBe("Ctrl+Shift+Z");
  });
});

describe("palette shortcut", () => {
  it("opens with Cmd+P on macOS and Ctrl+P elsewhere", () => {
    expect(
      matchesShortcut(PALETTE_SHORTCUT, key("p", { metaKey: true }), true),
    ).toBe(true);
    expect(
      matchesShortcut(PALETTE_SHORTCUT, key("p", { ctrlKey: true }), true),
    ).toBe(false);
    expect(
      matchesShortcut(PALETTE_SHORTCUT, key("p", { ctrlKey: true }), false),
    ).toBe(true);
    expect(
      matchesShortcut(PALETTE_SHORTCUT, key("p", { metaKey: true }), false),
    ).toBe(false);
    expect(
      matchesShortcut(
        PALETTE_SHORTCUT,
        key("P", { metaKey: true, shiftKey: true }),
        true,
      ),
    ).toBe(false);
    expect(matchesShortcut(PALETTE_SHORTCUT, key("p"), true)).toBe(false);
  });

  it("claims the app's own modified shortcuts while it is open", () => {
    expect(claimedWhilePaletteOpen(key("o", { metaKey: true }), true)).toBe(
      true,
    );
    expect(claimedWhilePaletteOpen(key("o", { ctrlKey: true }), false)).toBe(
      true,
    );
    expect(claimedWhilePaletteOpen(key("f", { metaKey: true }), true)).toBe(
      true,
    );
    expect(claimedWhilePaletteOpen(key("f", { ctrlKey: true }), false)).toBe(
      true,
    );
    expect(claimedWhilePaletteOpen(key("f", { ctrlKey: true }), true)).toBe(
      false,
    );
    expect(claimedWhilePaletteOpen(key("Escape"), true)).toBe(false);
    expect(claimedWhilePaletteOpen(key("ArrowDown"), true)).toBe(false);
  });

  it("stays out of text fields", () => {
    expect(typingIn({ tagName: "INPUT", type: "text" })).toBe(true);
    expect(typingIn({ tagName: "INPUT", type: "search" })).toBe(true);
    expect(typingIn({ tagName: "TEXTAREA" })).toBe(true);
    expect(typingIn({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(typingIn({ tagName: "INPUT", type: "radio" })).toBe(false);
    expect(typingIn({ tagName: "INPUT", type: "color" })).toBe(false);
    expect(typingIn({ tagName: "TABLE" })).toBe(false);
    expect(typingIn(null)).toBe(false);
  });
});
