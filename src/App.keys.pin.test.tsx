// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import {
  dialogs,
  focused,
  get,
  historyRow,
  installHarness,
  mountApp,
  openFirstFile,
  query,
} from "./test/appHarness";

installHarness();

it("Ctrl+P opens the palette, but not in a text field and not while a dialog is open", async () => {
  const app = await mountApp();
  get("textbox", "Filter repositories and refs").focus();
  const typing = await app.press("p", { ctrlKey: true });
  expect(typing.defaultPrevented, "the shortcut is still claimed").toBe(true);
  expect(dialogs(), "not while typing").toEqual([]);

  await app.press("o", { ctrlKey: true, target: document.body });
  expect(dialogs()).toEqual(["Add a repository"]);
  const underDialog = await app.press("p", {
    ctrlKey: true,
    target: get("button", "Close add repository"),
  });
  expect(underDialog.defaultPrevented).toBe(true);
  expect(dialogs(), "not under a dialog").toEqual(["Add a repository"]);

  await app.click(get("button", "Close add repository"));
  const opened = await app.press("p", { ctrlKey: true, target: document.body });
  expect(opened.defaultPrevented).toBe(true);
  expect(dialogs()).toEqual(["Command palette"]);
  expect(focused()).toBe("combobox Search actions, repositories, and refs");
});

it("while the palette is open, claimed shortcuts are prevented and not run", async () => {
  const app = await mountApp();
  await app.press("p", { ctrlKey: true, target: document.body });
  app.bridge.reset();
  const addRepository = await app.press("o", { ctrlKey: true });
  expect(addRepository.defaultPrevented, "Ctrl+O is claimed").toBe(true);
  expect(dialogs(), "and not run").toEqual(["Command palette"]);
  const undo = await app.press("z", { ctrlKey: true });
  expect(undo.defaultPrevented, "Ctrl+Z yields to the search field").toBe(
    false,
  );
  expect(app.bridge.count("undo")).toBe(0);
});

it("Escape closes the open file; under an open dialog it does not", async () => {
  const app = await mountApp();
  await openFirstFile(app);
  expect(get("region", "Changes to notes.txt")).toBeTruthy();
  expect(query("grid", "Commits"), "History hides behind the file").toBeNull();

  await app.press("o", { ctrlKey: true, target: document.body });
  const underDialog = await app.press("Escape", {
    target: get("button", "Close add repository"),
  });
  expect(underDialog.defaultPrevented, "the app leaves Escape alone").toBe(
    false,
  );
  expect(dialogs(), "the dialog's own cancel closed it").toEqual([]);
  expect(get("region", "Changes to notes.txt")).toBeTruthy();

  const closing = await app.press("Escape", { target: document.body });
  expect(closing.defaultPrevented).toBe(true);
  expect(query("region", "Changes to notes.txt")).toBeNull();
  expect(get("grid", "Commits")).toBeTruthy();
});

it("Ctrl+Z undoes outside text fields and yields inside one, including inside a shadow root", async () => {
  const app = await mountApp();
  get("textbox", "Filter repositories and refs").focus();
  const inField = await app.press("z", { ctrlKey: true });
  expect(inField.defaultPrevented).toBe(false);

  const host = document.createElement("div");
  document.body.append(host);
  const shadowInput = document.createElement("input");
  host.attachShadow({ mode: "open" }).append(shadowInput);
  shadowInput.focus();
  const inShadow = await app.press("z", { ctrlKey: true, target: shadowInput });
  expect(inShadow.defaultPrevented).toBe(false);
  expect(app.bridge.count("undo"), "typing never undoes").toBe(0);

  const outside = await app.press("z", {
    ctrlKey: true,
    target: document.body,
  });
  expect(outside.defaultPrevented).toBe(true);
  expect(app.bridge.lines((request) => request.op === "undo")).toEqual([
    "undo /fixture/pin",
  ]);
});

it.todo(
  "a key pressed right after a commit sees that commit's context: act() flushes passive effects with the commit, so no keydown can land between them",
);

it("Ctrl+O opens Add repository even while another dialog is open", async () => {
  const app = await mountApp();
  await app.contextMenu(historyRow("Main tip,"));
  await app.click(get("menuitem", "Edit message…"));
  expect(dialogs()).toEqual(["Edit message"]);
  const event = await app.press("o", {
    ctrlKey: true,
    target: get("button", "Close edit message"),
  });
  expect(event.defaultPrevented).toBe(true);
  expect(dialogs()).toEqual(["Edit message", "Add a repository"]);
});

it("exactly one window keydown listener stays registered across renders", async () => {
  const listeners = new Set<unknown>();
  const bubbling = (options: unknown) =>
    options === undefined ||
    options === false ||
    (typeof options === "object" &&
      options !== null &&
      !(options as AddEventListenerOptions).capture);
  const originalAdd = window.addEventListener;
  const originalRemove = window.removeEventListener;
  const add = vi.spyOn(window, "addEventListener").mockImplementation(function (
    this: Window,
    type,
    listener,
    options,
  ) {
    if (type === "keydown" && bubbling(options)) listeners.add(listener);
    originalAdd.call(this, type, listener, options);
  });
  const remove = vi
    .spyOn(window, "removeEventListener")
    .mockImplementation(function (this: Window, type, listener, options) {
      if (type === "keydown" && bubbling(options)) listeners.delete(listener);
      originalRemove.call(this, type, listener, options);
    });
  try {
    const app = await mountApp();
    expect(listeners.size, "after the StrictMode mount").toBe(1);
    await app.click(historyRow("Release,"));
    await app.click(historyRow("Uncommitted changes in pin,"));
    await app.refocusWindow();
    expect(listeners.size, "after rerenders").toBe(1);
  } finally {
    add.mockRestore();
    remove.mockRestore();
  }
});

it("Ctrl+F opens History search", async () => {
  const app = await mountApp();
  const event = await app.press("f", { ctrlKey: true, target: document.body });
  expect(event.defaultPrevented).toBe(true);
  expect(focused()).toBe("textbox Search loaded history");
});

it("Ctrl+P from a text field inside a shadow root opens the palette (pins current behavior: palette detection reads event.target)", async () => {
  const app = await mountApp();
  const host = document.createElement("div");
  document.body.append(host);
  const shadowInput = document.createElement("input");
  host.attachShadow({ mode: "open" }).append(shadowInput);
  shadowInput.focus();
  await app.press("p", { ctrlKey: true, target: shadowInput });
  expect(dialogs()).toEqual(["Command palette"]);
});
