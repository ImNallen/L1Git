// @vitest-environment happy-dom
import { expect, it } from "vitest";
import type { RepositoryRoot } from "./domain/repository";
import { FAKE_HOME, folder } from "./test/fakeBridge";
import {
  dialogs,
  focused,
  get,
  installHarness,
  mountApp,
  query,
  queryAll,
} from "./test/appHarness";
import type { Harness } from "./test/appHarness";
import { addEmptyRepository, OTHER } from "./test/fixtures";

installHarness();

const DOCS = `${FAKE_HOME}/Projects/docs-site`;
const SHOTS = `${FAKE_HOME}/Projects/screenshots`;

const plus = () => get("button", "Add repository");
const palette = () => get("dialog", "Add repository");
const options = () =>
  queryAll("option").map((option) => {
    const title = option.querySelector(
      ".add-palette-source-title, .add-palette-directory-name",
    );
    return `${title?.textContent}${option.getAttribute("aria-selected") === "true" ? " *" : ""}`;
  });
const hints = () =>
  [...document.querySelectorAll(".add-palette-hint")].map(
    (hint) =>
      `${hint.textContent}${hint.classList.contains("disabled") ? " [disabled]" : ""}`,
  );
const location = (name: string) => get("textbox", name) as HTMLInputElement;
const submit = (name: string) => get("button", name) as HTMLButtonElement;

const doubleClick = (app: Harness, title: RegExp) =>
  app.act(() => {
    get("option", title).dispatchEvent(
      new MouseEvent("dblclick", { bubbles: true }),
    );
  });

async function openPalette(app: Harness) {
  await app.click(plus());
  return palette();
}

async function openSource(app: Harness, title: RegExp) {
  await openPalette(app);
  await app.click(get("option", title));
}

function opensDocs(world: Parameters<typeof addEmptyRepository>[0]) {
  addEmptyRepository(world, DOCS as RepositoryRoot);
}

it("lists the sources in order, and a query filters by title", async () => {
  const app = await mountApp();
  await openPalette(app);
  expect(focused()).toBe("combobox Search sources");
  expect(options()).toEqual(["Local folder *", "Git URL", "New repository"]);
  expect(hints()).toEqual(["↑ ↓Navigate", "↵Select", "EscClose"]);

  await app.type(get("combobox", "Search sources"), "g");
  expect(options()).toEqual(["Git URL *"]);
  expect(hints()).toEqual(["↑ ↓Navigate", "↵Select", "⌫Clear", "EscClose"]);

  await app.type(get("combobox", "Search sources"), "zzz");
  expect(options()).toEqual([]);
  expect(get("status", undefined, palette()).textContent).toBe(
    "Nothing matches “zzz”.",
  );
  expect(hints()).toContain("↵Select [disabled]");
});

it("Up, Down, and Enter open a source from the search field", async () => {
  const app = await mountApp();
  await openPalette(app);
  await app.press("ArrowDown");
  await app.press("ArrowDown");
  expect(options()).toEqual(["Local folder", "Git URL", "New repository *"]);
  await app.press("ArrowDown");
  expect(options()[0]).toBe("Local folder *");
  await app.press("ArrowUp");
  await app.press("ArrowUp");
  expect(options()[1]).toBe("Git URL *");
  await app.press("Enter");
  expect(focused()).toBe("textbox Git URL");
  expect(hints()).toEqual(["TabMove focus", "↵Clone [disabled]", "EscClose"]);
});

it("New repository creates at the derived location and opens it", async () => {
  const app = await mountApp();
  await openSource(app, /^New repository/);
  expect(focused()).toBe("textbox Repository name");
  expect(submit("Create").disabled, "no name yet").toBe(true);

  await app.type(get("textbox", "Repository name"), "Sandbox");
  expect(location("Create in").value).toBe("~/Projects/Sandbox");
  expect(hints()).toEqual(["TabMove focus", "↵Create", "EscClose"]);
  app.bridge.reset();
  await app.click(submit("Create"));

  expect(app.bridge.log[0]).toEqual({
    op: "createRepository",
    path: "~/Projects/Sandbox",
  });
  expect(dialogs()).toEqual([]);
  const root = `${FAKE_HOME}/Projects/Sandbox`;
  expect(app.bridge.count("snapshot", root)).toBeGreaterThan(0);
  expect(
    document.querySelector(`.repository-open[title="${root}"]`),
    "the new repository is in the sidebar",
  ).not.toBeNull();
  expect(focused(), "success goes to the app's focus fallback").not.toBe(
    "button Add repository",
  );
});

it("Git URL clones to the location named by the URL and opens it", async () => {
  const app = await mountApp();
  await openSource(app, /^Git URL/);
  await app.type(
    get("textbox", "Git URL"),
    "https://github.com/example/docs-site.git",
  );
  expect(location("Clone into").value).toBe("~/Projects/docs-site");
  app.bridge.reset();
  await app.click(submit("Clone"));
  expect(app.bridge.log[0]).toEqual({
    op: "cloneRepository",
    url: "https://github.com/example/docs-site.git",
    path: "~/Projects/docs-site",
  });
  expect(dialogs()).toEqual([]);
  expect(app.bridge.count("snapshot", DOCS)).toBeGreaterThan(0);
  expect(app.bridge.count("cancelClone"), "nothing to cancel").toBe(0);
});

it("Local folder lists the base and adds the highlighted repository", async () => {
  const app = await mountApp({ world: opensDocs });
  await openSource(app, /^Local folder/);
  expect(focused()).toBe("combobox Path");
  expect((get("combobox", "Path") as HTMLInputElement).value).toBe(
    "~/Projects",
  );
  expect(options()).toEqual(["docs-site *", "screenshots"]);
  expect(get("listbox", "Directories").textContent).toContain(
    "No Git repository",
  );
  app.bridge.reset();
  await app.click(submit("Open"));
  expect(dialogs()).toEqual([]);
  expect(app.bridge.count("snapshot", DOCS)).toBeGreaterThan(0);
  expect(app.bridge.count("createRepository")).toBe(0);
});

it("a non-Git row disables Open and its footer hint", async () => {
  const app = await mountApp({ world: opensDocs });
  await openSource(app, /^Local folder/);
  expect(hints()).toContain("↵Open");
  await app.press("ArrowDown");
  expect(options()).toEqual(["docs-site", "screenshots *"]);
  expect(submit("Open").disabled).toBe(true);
  expect(hints()).toContain("↵Open [disabled]");
  await app.press("ArrowDown", { target: get("button", "Back") });
  expect(options(), "the arrows work wherever focus is").toEqual([
    "docs-site *",
    "screenshots",
  ]);
  expect(submit("Open").disabled).toBe(false);
});

it("highlighting a non-Git row from Add moves focus to the path, so keys keep working", async () => {
  const app = await mountApp({ world: opensDocs });
  await openSource(app, /^Local folder/);
  submit("Open").focus();
  await app.press("ArrowDown");
  expect(submit("Open").disabled).toBe(true);
  expect(focused()).toBe("combobox Path");
  await app.press("ArrowUp");
  expect(options()[0]).toBe("docs-site *");
});

it("a double-click adds a repository and enters any other folder", async () => {
  const app = await mountApp({
    world: (world) => {
      opensDocs(world);
      world.directories.set("~/Projects/screenshots", [
        folder(`${SHOTS}/march`, false),
      ]);
    },
  });
  await openSource(app, /^Local folder/);
  await doubleClick(app, /^screenshots/);
  expect((get("combobox", "Path") as HTMLInputElement).value).toBe(
    "~/Projects/screenshots",
  );
  expect(options()).toEqual(["march *"]);
  await app.type(get("combobox", "Path"), "~/Projects");
  await doubleClick(app, /^docs-site/);
  expect(dialogs()).toEqual([]);
  expect(app.bridge.count("snapshot", DOCS)).toBeGreaterThan(0);
});

it("ArrowRight enters the highlighted folder only with the caret at the end", async () => {
  const app = await mountApp();
  await openSource(app, /^Local folder/);
  const path = get("combobox", "Path") as HTMLInputElement;
  path.setSelectionRange(1, 1);
  const inside = await app.press("ArrowRight");
  expect(inside.defaultPrevented, "the caret moves normally").toBe(false);
  expect(path.value).toBe("~/Projects");

  path.setSelectionRange(path.value.length, path.value.length);
  await app.press("ArrowRight");
  expect((get("combobox", "Path") as HTMLInputElement).value).toBe(
    "~/Projects/docs-site",
  );
});

it("Backspace leaves the Local step from an empty path or a button", async () => {
  const app = await mountApp();
  await openSource(app, /^Local folder/);
  const typing = await app.press("Backspace");
  expect(typing.defaultPrevented, "the path edits normally").toBe(false);
  expect(query("combobox", "Path")).not.toBeNull();

  await app.type(get("combobox", "Path"), "");
  await app.press("Backspace");
  expect(focused()).toBe("combobox Search sources");

  await app.click(get("option", /^Local folder/));
  await app.press("Backspace", { target: get("button", "Back") });
  expect(focused()).toBe("combobox Search sources");
});

it("Back returns to the sources with focus in the search", async () => {
  const app = await mountApp();
  await openSource(app, /^Git URL/);
  await app.click(get("button", "Back"));
  expect(focused()).toBe("combobox Search sources");
  expect(options()[0]).toBe("Local folder *");
  expect(dialogs()).toEqual(["Add repository"]);
});

it("Escape from a step closes the whole palette and returns focus to +", async () => {
  const app = await mountApp();
  await openSource(app, /^New repository/);
  expect(focused()).toBe("textbox Repository name");
  await app.press("Escape");
  expect(dialogs()).toEqual([]);
  expect(focused()).toBe("button Add repository");
});

it("a backdrop press closes, and a drag that ends on it does not", async () => {
  const app = await mountApp();
  await openPalette(app);
  const press = (target: Element) =>
    app.act(() => {
      target.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });
  await press(get("combobox", "Search sources"));
  await app.click(palette());
  expect(dialogs()).toEqual(["Add repository"]);
  await press(palette());
  await app.click(palette());
  expect(dialogs()).toEqual([]);
  expect(focused()).toBe("button Add repository");
});

it("focus returns to what had it, or falls back when that is gone", async () => {
  const app = await mountApp();
  const search = get("textbox", "Filter repositories and refs");
  search.focus();
  await app.press("o", { ctrlKey: true, target: document.body });
  await app.press("Escape", { target: get("combobox", "Search sources") });
  expect(focused()).toBe("textbox Filter repositories and refs");

  (document.activeElement as HTMLElement).blur();
  await app.press("o", { ctrlKey: true, target: document.body });
  await app.press("Escape", { target: get("combobox", "Search sources") });
  expect(focused(), "History is the fallback").toBe("grid Commits");
});

it("Ctrl+O while open keeps the original return target", async () => {
  const app = await mountApp();
  await openPalette(app);
  await app.press("o", { ctrlKey: true });
  await app.press("Escape");
  expect(focused()).toBe("button Add repository");
});

it("the derived location follows the name until it is edited", async () => {
  const app = await mountApp();
  await openSource(app, /^New repository/);
  const name = get("textbox", "Repository name");
  await app.type(name, "One");
  expect(location("Create in").value).toBe("~/Projects/One");
  await app.type(name, "Two");
  expect(location("Create in").value).toBe("~/Projects/Two");

  await app.type(location("Create in"), "/elsewhere/Mine");
  await app.type(name, "Three");
  expect(location("Create in").value).toBe("/elsewhere/Mine");
  app.bridge.reset();
  await app.click(submit("Create"));
  expect(app.bridge.log[0]).toMatchObject({
    op: "createRepository",
    path: "/elsewhere/Mine",
  });
});

it("the base falls back to home when home has no Projects", async () => {
  const app = await mountApp({
    world: (world) => {
      world.directories.set("~", [folder(`${FAKE_HOME}/Music`, false)]);
      world.directories.set("~/Music", []);
    },
  });
  await openSource(app, /^New repository/);
  await app.type(get("textbox", "Repository name"), "Sandbox");
  expect(location("Create in").value).toBe("~/Sandbox");
  await app.click(get("button", "Back"));
  await app.click(get("option", /^Local folder/));
  expect((get("combobox", "Path") as HTMLInputElement).value).toBe("~");
});

it("the steps keep the Tab order Back, input, primary, location", async () => {
  const app = await mountApp();
  await openSource(app, /^New repository/);
  const order = [...palette().querySelectorAll("button, input")].map(
    (element) => element.getAttribute("aria-label") ?? element.id,
  );
  expect(order).toEqual([
    "Back",
    "Repository name",
    "Create",
    "add-palette-location",
  ]);
});

it("Tab wraps inside the palette instead of leaving it", async () => {
  const app = await mountApp();
  await openPalette(app);
  const alone = await app.press("Tab");
  expect(alone.defaultPrevented, "the search is the only control").toBe(true);
  expect(focused()).toBe("combobox Search sources");

  await app.click(get("option", /^New repository/));
  location("Create in").focus();
  await app.press("Tab");
  expect(focused()).toBe("button Back");
  await app.press("Tab", { shiftKey: true });
  expect(focused()).toBe("textbox Create in");
  const inside = await app.press("Tab", { shiftKey: true });
  expect(inside.defaultPrevented, "the browser moves focus inside").toBe(false);
});

it("Tab wraps past a disabled Add in the Local step", async () => {
  const app = await mountApp();
  await openSource(app, /^Local folder/);
  await app.press("ArrowDown");
  expect(submit("Open").disabled).toBe(true);
  await app.press("Tab");
  expect(focused()).toBe("button Back");
});

it("a refusal shows under the field and keeps the step open", async () => {
  const app = await mountApp();
  await openSource(app, /^New repository/);
  app.bridge.fail("createRepository", {
    kind: "gitFailed",
    message: "This folder is already a Git repository.",
  });
  await app.type(get("textbox", "Repository name"), "Taken");
  await app.click(submit("Create"));
  expect(get("alert").textContent).toBe(
    "This folder is already a Git repository.",
  );
  expect(dialogs()).toEqual(["Add repository"]);
  expect(focused()).toBe("textbox Repository name");
  await app.type(get("textbox", "Repository name"), "Free");
  expect(query("alert"), "editing clears it").toBeNull();
});

it("a repository that fails to open keeps its error in the step", async () => {
  const app = await mountApp({
    world: (world) => world.snapshots.delete(OTHER),
  });
  await openSource(app, /^Local folder/);
  app.bridge.respond("listDirectories", () => ({
    entries: [folder(OTHER, true)],
  }));
  await app.type(get("combobox", "Path"), "/fixture");
  await app.click(submit("Open"));
  expect(get("alert").textContent).toContain("/fixture/other");
  expect(dialogs()).toEqual(["Add repository"]);
  expect(submit("Open").disabled).toBe(false);
});

it("while busy, inputs and Back are disabled and the button says so", async () => {
  const app = await mountApp();
  await openSource(app, /^New repository/);
  await app.type(get("textbox", "Repository name"), "Sandbox");
  const held = app.bridge.hold("createRepository");
  await app.click(submit("Create"));
  await held.arrived;
  expect(submit("Creating…").disabled).toBe(true);
  expect((get("button", "Back") as HTMLButtonElement).disabled).toBe(true);
  expect((get("textbox", "Repository name") as HTMLInputElement).disabled).toBe(
    true,
  );
  expect(location("Create in").disabled).toBe(true);
  held.release();
  await app.settle();
  expect(dialogs()).toEqual([]);
});

it("Escape during a clone closes, cancels it, and opens nothing", async () => {
  const app = await mountApp();
  await openSource(app, /^Git URL/);
  await app.type(get("textbox", "Git URL"), "https://host/app.git");
  const held = app.bridge.hold("cloneRepository");
  await app.click(submit("Clone"));
  await held.arrived;
  expect(submit("Cloning…")).toBeTruthy();

  await app.press("Escape", { target: palette() });
  expect(dialogs()).toEqual([]);
  expect(focused()).toBe("button Add repository");
  expect(app.bridge.log.filter(({ op }) => op === "cancelClone")).toEqual([
    { op: "cancelClone", path: "~/Projects/app" },
  ]);

  held.release();
  await app.settle();
  const root = `${FAKE_HOME}/Projects/app`;
  expect(app.bridge.count("snapshot", root), "it never opens").toBe(0);
});

it("a slow listing does not overwrite a newer one", async () => {
  const app = await mountApp({
    world: (world) => {
      world.directories.set("/old", [folder("/old/stale", false)]);
      world.directories.set("/new", [folder("/new/fresh", false)]);
    },
  });
  await openSource(app, /^Local folder/);
  const held = app.bridge.hold("listDirectories", "/old");
  const path = get("combobox", "Path");
  await app.type(path, "/old");
  await held.arrived;
  await app.type(path, "/new");
  held.release();
  await app.settle();
  expect(options()).toEqual(["fresh *"]);
});

it("Add waits for the listing of the path it would add from", async () => {
  const app = await mountApp({
    world: (world) => {
      opensDocs(world);
      world.directories.set("/slow", [folder("/slow/x", true)]);
    },
  });
  await openSource(app, /^Local folder/);
  const held = app.bridge.hold("listDirectories", "/slow");
  await app.type(get("combobox", "Path"), "/slow");
  await held.arrived;
  expect(options()[0], "the old rows stay on screen").toBe("docs-site *");
  expect(submit("Open").disabled).toBe(true);
  held.release();
  await app.settle();
  expect(options()).toEqual(["x *"]);
  expect(submit("Open").disabled).toBe(false);
});

it("a double-click and ArrowRight wait for the listing of the typed path", async () => {
  const app = await mountApp({
    world: (world) => {
      opensDocs(world);
      world.directories.set("/slow", [folder("/slow/x", true)]);
    },
  });
  await openSource(app, /^Local folder/);
  const held = app.bridge.hold("listDirectories", "/slow");
  await app.type(get("combobox", "Path"), "/slow");
  await held.arrived;
  expect(options()[0], "the old rows stay on screen").toBe("docs-site *");

  await doubleClick(app, /^docs-site/);
  await doubleClick(app, /^screenshots/);
  await app.press("ArrowRight", { target: get("combobox", "Path") });

  expect(app.bridge.count("snapshot", DOCS)).toBe(0);
  expect(dialogs()).toEqual(["Add repository"]);
  expect((get("combobox", "Path") as HTMLInputElement).value).toBe("/slow");
  held.release();
  await app.settle();
  expect(options()).toEqual(["x *"]);
});

it("a listing the core refuses shows its message", async () => {
  const app = await mountApp();
  await openSource(app, /^Local folder/);
  app.bridge.fail("listDirectories", {
    kind: "unsupportedPath",
    message: "Enter an absolute path, or one that starts with ~.",
  });
  await app.type(get("combobox", "Path"), "relative");
  expect(get("alert").textContent).toContain("absolute path");
  expect(submit("Open").disabled).toBe(true);
});

it("an empty directory says so", async () => {
  const app = await mountApp({
    world: (world) => world.directories.set("/empty", []),
  });
  await openSource(app, /^Local folder/);
  await app.type(get("combobox", "Path"), "/empty");
  expect(get("status", undefined, palette()).textContent).toBe(
    "No directories here.",
  );
});

it("opens from the empty state and the command palette too", async () => {
  const app = await mountApp({ saved: { entries: [], lastRoot: null } });
  await app.click(get("button", "Add repository", get("complementary")));
  expect(dialogs()).toEqual(["Add repository"]);
  await app.press("Escape");
  await app.runPaletteItem("Add repository");
  expect(dialogs()).toEqual(["Add repository"]);
});
