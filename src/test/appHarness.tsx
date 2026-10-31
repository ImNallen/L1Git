import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { RECENTS_KEY } from "../domain/recents";
import { COLUMNS_KEY } from "../historyColumns";
import { createBridge, createWorld } from "./fakeBridge";
import type { Bridge, World } from "./fakeBridge";
import { OTHER, PIN } from "./fixtures";
import type { RepositoryRoot } from "../domain/repository";

type Media = {
  matches: boolean;
  listeners: Set<(event: MediaQueryListEvent) => void>;
};

/**
 * happy-dom gives every element one client rect and lets hidden elements take
 * focus, so App's `shownElement` checks would pass for the wrong reason.
 */
function hiddenByLayout(element: Element): boolean {
  return (
    !element.isConnected ||
    element.closest("[hidden], dialog:not([open])") !== null
  );
}

const NO_RECTS = {
  length: 0,
  item: () => null,
  [Symbol.iterator]: function* () {},
} as unknown as DOMRectList;

/**
 * happy-dom's modal dialogs neither make the page inert nor hand focus back
 * to their opener on close, and Escape never cancels them. Browsers do all
 * three, and App's focus fallbacks depend on them.
 */
function installDialogs(focus: (element: HTMLElement) => void) {
  const modals: { dialog: HTMLDialogElement; opener: Element | null }[] = [];
  const showModal = HTMLDialogElement.prototype.showModal;
  const close = HTMLDialogElement.prototype.close;
  const topmost = () => {
    for (let index = modals.length - 1; index >= 0; index -= 1) {
      const { dialog } = modals[index]!;
      if (dialog.isConnected && dialog.open) return modals[index]!;
      modals.splice(index, 1);
    }
    return null;
  };
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    const opener = document.activeElement;
    showModal.call(this);
    modals.push({ dialog: this, opener });
    if (!this.contains(document.activeElement)) {
      const first = this.querySelector<HTMLElement>(
        "button, input, select, textarea, [tabindex]",
      );
      if (first) focus(first);
    }
  };
  HTMLDialogElement.prototype.close = function (
    this: HTMLDialogElement,
    returnValue?: string,
  ) {
    const index = modals.findIndex((modal) => modal.dialog === this);
    const opener = index >= 0 ? modals[index]!.opener : null;
    if (index >= 0) modals.splice(index, 1);
    close.call(this, returnValue);
    if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
  };
  return {
    inert(element: Element) {
      const modal = topmost();
      return modal !== null && !modal.dialog.contains(element);
    },
    topmost: () => topmost()?.dialog ?? null,
    restore() {
      HTMLDialogElement.prototype.showModal = showModal;
      HTMLDialogElement.prototype.close = close;
    },
  };
}

/** happy-dom leaves out `HTMLTableSectionElement.rows`, which History reads. */
function installTableRows() {
  const prototype = HTMLTableSectionElement.prototype;
  if ("rows" in prototype) return () => {};
  Object.defineProperty(prototype, "rows", {
    configurable: true,
    get(this: HTMLTableSectionElement) {
      return this.querySelectorAll(":scope > tr");
    },
  });
  return () => {
    delete (prototype as { rows?: unknown }).rows;
  };
}

function installDom(
  initialMedia: Record<string, boolean>,
  initialWidth: number,
) {
  const removeTableRows = installTableRows();
  const getClientRects = Element.prototype.getClientRects;
  const focus = HTMLElement.prototype.focus;
  Element.prototype.getClientRects = function (this: Element) {
    return hiddenByLayout(this) ? NO_RECTS : getClientRects.call(this);
  };
  const dialogs = installDialogs((element) => element.focus());
  HTMLElement.prototype.focus = function (
    this: HTMLElement,
    options?: FocusOptions,
  ) {
    if (!hiddenByLayout(this) && !dialogs.inert(this))
      focus.call(this, options);
  };

  const media = new Map<string, Media>();
  const entry = (query: string) => {
    let found = media.get(query);
    if (!found) {
      found = { matches: initialMedia[query] ?? false, listeners: new Set() };
      media.set(query, found);
    }
    return found;
  };
  const matchMedia = window.matchMedia;
  window.matchMedia = (query: string) => {
    const state = entry(query);
    return {
      get matches() {
        return state.matches;
      },
      media: query,
      onchange: null,
      addEventListener: (_type: string, listener: () => void) =>
        state.listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) =>
        state.listeners.delete(listener),
      addListener: (listener: () => void) => state.listeners.add(listener),
      removeListener: (listener: () => void) =>
        state.listeners.delete(listener),
      dispatchEvent: () => true,
    } as unknown as MediaQueryList;
  };

  const innerWidth = Object.getOwnPropertyDescriptor(window, "innerWidth");
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: initialWidth,
  });

  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  const requestAnimationFrame = window.requestAnimationFrame;
  const cancelAnimationFrame = window.cancelAnimationFrame;
  window.requestAnimationFrame = (callback) => {
    nextFrame += 1;
    frames.set(nextFrame, callback);
    return nextFrame;
  };
  window.cancelAnimationFrame = (handle) => {
    frames.delete(handle);
  };

  const clock = { offset: 10_000 };
  const realNow = performance.now.bind(performance);
  const now = vi
    .spyOn(performance, "now")
    .mockImplementation(() => realNow() + clock.offset);

  let documentHidden = false;
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => documentHidden,
  });

  return {
    dialogs,
    media: {
      set(query: string, matches: boolean) {
        const state = entry(query);
        state.matches = matches;
        for (const listener of state.listeners)
          listener({ matches, media: query } as MediaQueryListEvent);
      },
    },
    frames,
    clock,
    setHidden(value: boolean) {
      documentHidden = value;
    },
    restore() {
      removeTableRows();
      dialogs.restore();
      Element.prototype.getClientRects = getClientRects;
      HTMLElement.prototype.focus = focus;
      window.matchMedia = matchMedia;
      if (innerWidth) Object.defineProperty(window, "innerWidth", innerWidth);
      window.requestAnimationFrame = requestAnimationFrame;
      window.cancelAnimationFrame = cancelAnimationFrame;
      now.mockRestore();
      delete (document as { hidden?: boolean }).hidden;
    },
  };
}

type Dom = ReturnType<typeof installDom>;

export type SavedRepositories = {
  entries: readonly RepositoryRoot[];
  lastRoot: RepositoryRoot | null;
};

export type MountOptions = {
  world?: (world: World) => void;
  bridge?: (bridge: Bridge) => void;
  media?: Record<string, boolean>;
  innerWidth?: number;
  saved?: SavedRepositories;
};

function seedStorage(saved: SavedRepositories) {
  localStorage.clear();
  localStorage.setItem(
    RECENTS_KEY,
    JSON.stringify({
      version: 1,
      entries: saved.entries.map((root, index) => ({
        root,
        name: root.split("/").at(-1),
        openedAt: 1_700_000_000_000 + index,
      })),
      lastRoot: saved.lastRoot,
    }),
  );
  // The Changes column reads line stats on a 100 ms settle timer, which would
  // race every request log.
  localStorage.setItem(
    COLUMNS_KEY,
    JSON.stringify({ version: 1, visible: [] }),
  );
}

async function loadModules() {
  vi.resetModules();
  const [App, appearance, overview, draftProtection, resolutionDrafts] =
    await Promise.all([
      import("../App"),
      import("../appearance"),
      import("../overview"),
      import("../draftProtection"),
      import("../resolutionDrafts"),
      // App prefetches its lazy panes after launch; loading them here keeps a
      // test from racing that prefetch when it opens a file.
      import("../components/FileDiffPane"),
      import("../components/ConflictResolver"),
    ]);
  return { App, appearance, overview, draftProtection, resolutionDrafts };
}

type Modules = Awaited<ReturnType<typeof loadModules>>;

const IMPLICIT_ROLES: Record<string, string> = {
  BUTTON: "button",
  DIALOG: "dialog",
  TEXTAREA: "textbox",
  NAV: "navigation",
  ASIDE: "complementary",
  SECTION: "region",
};

function roleOf(element: Element): string | null {
  const explicit = element.getAttribute("role");
  if (explicit) return explicit;
  if (element instanceof HTMLInputElement)
    return element.type === "checkbox" ? "checkbox" : "textbox";
  return IMPLICIT_ROLES[element.tagName] ?? null;
}

function nameOf(element: Element): string {
  const label = element.getAttribute("aria-label");
  if (label) return label;
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy)
    return labelledBy
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ")
      .trim();
  if (element.id) {
    const labelled = document.querySelector(`label[for="${element.id}"]`);
    if (labelled) return (labelled.textContent ?? "").trim();
  }
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement
  )
    return element.placeholder;
  return (element.textContent ?? "").replace(/\s+/g, " ").trim();
}

const matches = (name: string, wanted: string | RegExp | undefined) =>
  wanted === undefined ||
  (typeof wanted === "string" ? name === wanted : wanted.test(name));

export function queryAll(
  role: string,
  name?: string | RegExp,
  within: ParentNode = document,
): HTMLElement[] {
  return [...within.querySelectorAll<HTMLElement>("*")].filter(
    (element) =>
      roleOf(element) === role &&
      !hiddenByLayout(element) &&
      matches(nameOf(element), name),
  );
}

export function query(
  role: string,
  name?: string | RegExp,
  within?: ParentNode,
): HTMLElement | null {
  const found = queryAll(role, name, within);
  if (found.length > 1)
    throw new Error(
      `${found.length} ${role} elements are named ${String(name)}.`,
    );
  return found[0] ?? null;
}

export function get(
  role: string,
  name?: string | RegExp,
  within?: ParentNode,
): HTMLElement {
  const found = query(role, name, within);
  if (found) return found;
  const names = queryAll(role, undefined, within).map(nameOf);
  throw new Error(
    `No ${role} is named ${String(name)}. Shown: ${JSON.stringify(names)}`,
  );
}

/**
 * happy-dom reports the innermost node as `event.target` everywhere. Browsers
 * retarget it to the shadow host for listeners outside the shadow tree.
 */
function retargetAcrossShadowRoots(event: Event, origin: EventTarget) {
  if (
    !(origin instanceof Node) ||
    !(origin.getRootNode() instanceof ShadowRoot)
  )
    return;
  Object.defineProperty(event, "target", {
    configurable: true,
    get() {
      const listener = event.currentTarget;
      let target: Node = origin;
      for (
        let root = target.getRootNode();
        root instanceof ShadowRoot &&
        !(listener instanceof Node && root.contains(listener));
        root = target.getRootNode()
      )
        target = root.host;
      return target;
    },
  });
}

export function focused(): string {
  let element = document.activeElement;
  while (element?.shadowRoot?.activeElement)
    element = element.shadowRoot.activeElement;
  if (element === null || element === document.body) return "body";
  return `${roleOf(element) ?? element.tagName.toLowerCase()} ${nameOf(element)}`;
}

export function selectedRow(): string | null {
  const row = document.querySelector('[role="row"][aria-selected="true"]');
  if (!row) return null;
  const cell = row.querySelector(".commit-cell");
  return cell ? nameOf(cell) : nameOf(row);
}

export function refRow(
  name: string,
  root: RepositoryRoot = PIN,
): HTMLElement | null {
  const group = [
    ...document.querySelectorAll(".repository-tree .repository-group"),
  ].find((candidate) =>
    candidate.querySelector(`.repository-open[title="${root}"]`),
  );
  return (
    [...(group?.querySelectorAll<HTMLElement>(".branch-row") ?? [])].find(
      (row) =>
        !hiddenByLayout(row) &&
        (row.getAttribute("title") ?? "").startsWith(`${name} ·`),
    ) ?? null
  );
}

export function repositoryRow(root: RepositoryRoot): HTMLElement {
  const row = document.querySelector<HTMLElement>(
    `.repository-tree .repository-open[title="${root}"]`,
  );
  if (!row) throw new Error(`The sidebar does not list ${root}.`);
  return row;
}

export function inspectorTitle(): string | null {
  const inspector = query("complementary", "Commit inspector");
  return inspector?.querySelector("h2")?.textContent ?? null;
}

export function historyRow(label: string): HTMLElement {
  const row = [
    ...document.querySelectorAll<HTMLElement>('[role="grid"] [role="row"]'),
  ].find((candidate) => {
    const cell = candidate.querySelector(".commit-cell");
    return cell !== null && nameOf(cell).startsWith(label);
  });
  if (!row) throw new Error(`History shows no row labelled ${label}.`);
  return row;
}

export function dialogs(): string[] {
  return queryAll("dialog").map(nameOf);
}

export async function openFirstFile(app: Harness) {
  const grid = get("grid", "Commits");
  grid.focus();
  await app.press("Enter");
}

export async function dirtyResolution(
  app: Harness,
  root: RepositoryRoot,
  path: string,
) {
  const drafts = app.modules.resolutionDrafts;
  await app.act(async () => {
    await drafts.readResolution(root, path);
    const key = drafts.resolutionKey(root, path);
    const draft = drafts.resolutionOf(key);
    if (!draft) throw new Error(`No conflict draft for ${path}.`);
    drafts.chooseResolution(key, draft.editorEpoch, "resolved by hand\n");
  });
}

export function paletteTitles(): string[] {
  return queryAll("option").map((option) => {
    const title = option.querySelector(".command-palette-title")?.textContent;
    const kind = option.querySelector(".command-palette-kind")?.textContent;
    const disabled = option.getAttribute("aria-disabled") === "true";
    return `${title}${kind ? ` (${kind})` : ""}${disabled ? " [disabled]" : ""}`;
  });
}

export type Harness = {
  bridge: Bridge;
  modules: Modules;
  dom: Dom;
  settle(): Promise<void>;
  flushFrames(): Promise<void>;
  press(
    key: string,
    options?: KeyboardEventInit & { target?: EventTarget },
  ): Promise<KeyboardEvent>;
  click(element: Element): Promise<void>;
  contextMenu(element: Element): Promise<void>;
  type(element: Element, value: string): Promise<void>;
  refocusWindow(): Promise<void>;
  runPaletteItem(title: string): Promise<void>;
  act(run: () => void | Promise<void>): Promise<void>;
};

let mounted: { unmount(): Promise<void>; dom: Dom; bridge: Bridge } | null =
  null;

export function installHarness() {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });
  afterEach(async () => {
    if (mounted) {
      const { bridge } = mounted;
      await mounted.unmount();
      mounted = null;
      expect(
        bridge.unexpected,
        "requests the fake bridge cannot answer",
      ).toEqual([]);
    }
    vi.unstubAllGlobals();
    localStorage.clear();
    document.body.replaceChildren();
  });
}

export async function mountApp(options: MountOptions = {}): Promise<Harness> {
  const world = createWorld();
  options.world?.(world);
  const bridge = createBridge(world);
  options.bridge?.(bridge);
  seedStorage(options.saved ?? { entries: [PIN, OTHER], lastRoot: PIN });
  vi.stubGlobal("fetch", bridge.fetch);
  const dom = installDom(options.media ?? {}, options.innerWidth ?? 1400);
  const modules = await loadModules();
  const { App } = modules.App;
  const container = document.createElement("div");
  container.id = "root";
  document.body.append(container);
  const root = createRoot(container);

  async function settle() {
    let idle = 0;
    for (let round = 0; round < 200; round += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      idle = bridge.active() === 0 ? idle + 1 : 0;
      if (idle >= 2) return;
    }
    throw new Error("The app kept sending requests.");
  }

  const harness: Harness = {
    bridge,
    modules,
    dom,
    settle,
    async flushFrames() {
      await act(async () => {
        const pending = [...dom.frames.values()];
        dom.frames.clear();
        for (const frame of pending) frame(performance.now());
      });
      await settle();
    },
    async press(key, { target, ...init } = {}) {
      const event = new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
        composed: true,
        ...init,
      });
      const origin = target ?? document.activeElement ?? document.body;
      retargetAcrossShadowRoots(event, origin);
      await act(async () => {
        origin.dispatchEvent(event);
        const dialog = dom.dialogs.topmost();
        if (key === "Escape" && !event.defaultPrevented && dialog) {
          const cancel = new Event("cancel", { cancelable: true });
          if (dialog.dispatchEvent(cancel)) dialog.close();
        }
      });
      await settle();
      return event;
    },
    async click(element) {
      await act(async () => {
        (element as HTMLElement).click();
      });
      await settle();
    },
    async contextMenu(element) {
      await act(async () => {
        element.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: 10,
            clientY: 10,
          }),
        );
      });
      await settle();
    },
    async type(element, value) {
      const prototype =
        element instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      await act(async () => {
        Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
          element,
          value,
        );
        element.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await settle();
    },
    async refocusWindow() {
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
      });
      await settle();
    },
    async runPaletteItem(title) {
      await harness.press("p", { ctrlKey: true });
      const option = queryAll("option").find(
        (item) =>
          item.querySelector(".command-palette-title")?.textContent === title,
      );
      if (!option)
        throw new Error(
          `The palette has no ${title}. Shown: ${JSON.stringify(paletteTitles())}`,
        );
      await harness.click(option);
    },
    async act(run) {
      await act(async () => {
        await run();
      });
      await settle();
    },
  };

  await act(async () => {
    root.render(
      <StrictMode>
        <App initialTheme={modules.appearance.initializeAppearance()} />
      </StrictMode>,
    );
  });
  await settle();

  mounted = {
    dom,
    bridge,
    async unmount() {
      await act(async () => root.unmount());
      dom.restore();
    },
  };
  return harness;
}
