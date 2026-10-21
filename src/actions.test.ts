import { describe, expect, it, vi } from "vitest";
import { filterPalette, paletteItems, shortcutAction } from "./actions";
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
    jumpToBranch: vi.fn(),
  };
}

const repositories = [
  { root: "/work/l1-demo" as RepositoryRoot, name: "l1-demo" },
  { root: "/work/sync" as RepositoryRoot, name: "sync" },
];
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

function titles(context: ActionContext, query: string, mac = true) {
  return filterPalette(
    paletteItems(context, commands(), mac, repositories, branches),
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
      sidebarBranch: { name: "feature/fetch-retry", visibility: "hidden" },
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
      sidebarBranch: { name: "main", visibility: "soloed" },
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
    const items = paletteItems(
      repositoryScreen,
      run,
      true,
      repositories,
      branches,
    );
    filterPalette(items, "origin/main")[0]?.run();
    filterPalette(items, "sync")[0]?.run();
    filterPalette(items, "fetch")[0]?.run();
    expect(run.jumpToBranch).toHaveBeenCalledWith("refs/remotes/origin/main");
    expect(run.openRepository).toHaveBeenCalledWith("/work/sync");
    expect(run.fetch).toHaveBeenCalledOnce();
  });

  it("labels shortcuts for the platform", () => {
    const items = paletteItems(repositoryScreen, commands(), true, [], []);
    const other = paletteItems(repositoryScreen, commands(), false, [], []);
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
          [],
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
