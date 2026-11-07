import { flushSync } from "react-dom";

export function requireElement<T extends Element>(
  selector: string,
  root: ParentNode = document,
) {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
}
export const wait = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));
export const act = (action: () => void) => flushSync(action);
export async function until(test: () => boolean) {
  const start = performance.now();
  while (!test()) {
    if (performance.now() - start > 10000)
      throw new Error("Visible app did not become ready");
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
}
export const check = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
};
export const rows = () => [
  ...document.querySelectorAll<HTMLElement>(".history-table [data-motion-row]"),
];
const paint = () => requireElement<HTMLElement>(".history-selection");
export const scroller = () => requireElement<HTMLElement>(".history-scroll");
export function context() {
  const branch = requireElement<HTMLButtonElement>(
    '.branch-row[title^="refs/heads/main "]',
  );
  act(() =>
    branch.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        clientX: 140,
        clientY: 200,
      }),
    ),
  );
}
export function command(name: string) {
  const button = [
    ...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
  ].find((button) => button.textContent?.trim() === name);
  if (!button) throw new Error(`Missing menu command ${name}`);
  act(() => button.click());
}
async function samples<T>(read: () => T, duration = 320) {
  const values: T[] = [];
  const start = performance.now();
  await new Promise<void>((resolve) => {
    const frame = () => {
      values.push(read());
      if (performance.now() - start < duration) requestAnimationFrame(frame);
      else resolve();
    };
    requestAnimationFrame(frame);
  });
  return values;
}
const varying = (values: readonly (number | string | undefined)[]) =>
  new Set(values).size > 3;
const y = () => paint().getBoundingClientRect().y;
const paneExit = () =>
  document.querySelector<HTMLElement>('[data-motion-exit="workspace-pane"]');
const exitOpacity = () => {
  const exit = paneExit();
  return exit
    ? Number(getComputedStyle(exit).opacity) *
        Number(
          getComputedStyle(requireElement<HTMLElement>(":scope > *", exit))
            .opacity,
        )
    : 0;
};
export async function openCode() {
  await until(
    () =>
      !!document
        .querySelector("file-tree-container")
        ?.shadowRoot?.querySelector('[role="treeitem"][aria-level="1"]'),
  );
  const root = requireElement<HTMLElement>("file-tree-container").shadowRoot;
  if (!root) throw new Error("Missing actual Pierre tree");
  act(() =>
    requireElement<HTMLElement>(
      '[role="treeitem"]:not([aria-expanded])',
      root,
    ).click(),
  );
  await until(() => !!document.querySelector(".file-diff"));
}
export function back() {
  act(() =>
    requireElement<HTMLButtonElement>(".file-diff-toolbar button").click(),
  );
}

export async function verifyTableMotion() {
  check(
    !matchMedia("(prefers-reduced-motion: reduce)").matches,
    "Run normal motion before reduced-motion checks",
  );
  if (document.querySelector(".file-diff")) {
    back();
    await wait(300);
  }
  context();
  const reset = [
    ...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
  ].find((button) => button.textContent?.trim() === "Show all branches");
  if (reset) act(() => reset.click());
  else
    act(() =>
      requireElement<HTMLElement>('[role="menu"]').dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
  await wait(300);
  check(
    rows().length >= 8,
    "Use the real nine-commit fixture with branch-only commits",
  );
  const first = rows()[0];
  const last = rows().at(-1);
  if (!first || !last) throw new Error("Missing history rows");
  act(() => first.click());
  await wait(280);
  const selectionStart = y();
  act(() => last.click());
  await Promise.resolve();
  const selectionFirst = y();
  check(
    Math.abs(selectionStart - selectionFirst) < 1,
    "Selection must start at the displayed outgoing pose",
  );
  const selection = await samples(y);
  check(
    varying(selection),
    "Selection decoration must move through displayed positions",
  );
  check(
    Math.abs(
      y() -
        requireElement<HTMLElement>("tr.selected").getBoundingClientRect().y,
    ) < 1,
    "Selection paint must settle on the real selected row",
  );
  act(() => first.click());
  await wait(70);
  const reversalStarted = performance.now();
  const reversalBefore = y();
  act(() => last.click());
  await Promise.resolve();
  const reversalAfter = y();
  const reversalElapsed = performance.now() - reversalStarted;
  const selectionDistance = Math.abs(
    selectionStart - (selection.at(-1) ?? selectionStart),
  );
  check(
    Math.abs(reversalBefore - reversalAfter) <
      1 + ((2 * selectionDistance) / 220) * reversalElapsed,
    `Selection reversal jumped beyond elapsed ease-out progress: ${JSON.stringify({ reversalBefore, reversalAfter, reversalElapsed })}`,
  );
  await wait(280);

  context();
  await wait(250);
  const beforeRows = new Map(
    rows().map((row) => [row.dataset.motionRow, row.getBoundingClientRect().y]),
  );
  command("Solo");
  const filtered = await samples(() =>
    rows().map((row) => ({
      id: row.dataset.motionRow,
      y: row.getBoundingClientRect().y,
      geometry: [...row.querySelectorAll<SVGElement>("[data-graph-key]")]
        .map(
          (node) =>
            `${node.dataset.graphKey}:${node.getAttribute("cx") ?? node.getAttribute("d")}`,
        )
        .join("|"),
    })),
  );
  const shared = rows()
    .map((row) => row.dataset.motionRow)
    .filter((id) => beforeRows.has(id));
  check(
    shared.some((id) =>
      varying(filtered.map((frame) => frame.find((row) => row.id === id)?.y)),
    ),
    "Shared keyed rows must move under branch filtering",
  );
  check(
    shared.some((id) =>
      varying(
        filtered.map((frame) => frame.find((row) => row.id === id)?.geometry),
      ),
    ),
    "Shared graph geometry must interpolate with its rows",
  );
  check(
    !document.querySelector('[data-motion-exit="history-row"]'),
    "Removed row exits must expire",
  );
  context();
  command("Show all branches");
  const restored = await samples(() =>
    rows().map((row) => ({
      id: row.dataset.motionRow,
      y: row.getBoundingClientRect().y,
    })),
  );
  check(
    shared.some((id) =>
      varying(restored.map((frame) => frame.find((row) => row.id === id)?.y)),
    ),
    "Showing branches must animate rows back",
  );
  const target = rows().at(-1);
  if (!target) throw new Error("Missing last fixture commit");
  act(() => target.click());
  await wait(300);
  const scroll = { top: scroller().scrollTop, left: scroller().scrollLeft };
  await openCode();
  const opening = await samples(() => ({
    opacity: getComputedStyle(requireElement<HTMLElement>(".file-diff"))
      .opacity,
    exit: exitOpacity(),
    header: paneExit()?.querySelector("thead")?.getBoundingClientRect().y,
    body: paneExit()?.querySelector("tbody")?.getBoundingClientRect().y,
    copies:
      paneExit()?.querySelectorAll("diffs-container,file-tree-container")
        .length ?? 0,
  }));
  check(varying(opening.map((frame) => frame.opacity)), "Code must fade in");
  check(
    opening.every((frame) => frame.copies === 0),
    "Exiting paint cannot create renderer copies",
  );
  back();
  await Promise.resolve();
  const returning = await samples(() => ({
    opacity: getComputedStyle(requireElement<HTMLElement>(".history")).opacity,
    header:
      requireElement<HTMLElement>(".history thead").getBoundingClientRect().y,
    body: requireElement<HTMLElement>(".history tbody").getBoundingClientRect()
      .y,
    marker: y(),
    exit: exitOpacity(),
  }));
  check(
    varying(returning.map((frame) => frame.opacity)),
    "History must fade back in",
  );
  check(
    varying(returning.map((frame) => frame.body)),
    "History rows must move back into place",
  );
  check(
    new Set(returning.map((frame) => frame.header)).size === 1,
    "History headings stay stationary",
  );
  check(
    document.activeElement?.matches(".history-table") === true,
    "Back returns focus to the real history table",
  );
  check(
    scroller().scrollTop === scroll.top &&
      scroller().scrollLeft === scroll.left,
    "Back preserves both scroll axes",
  );
  await openCode();
  await wait(70);
  const returnStarted = performance.now();
  const reversalOpacity = exitOpacity();
  back();
  await Promise.resolve();
  const returnOpacity = Number(
    getComputedStyle(requireElement<HTMLElement>(".history")).opacity,
  );
  check(
    Math.abs(reversalOpacity - returnOpacity) <
      0.01 + (2 / 240) * (performance.now() - returnStarted),
    "Back during entry resumes the displayed composite",
  );
  await wait(300);
  check(
    !document.querySelector("[data-motion-exit]"),
    "All transition paint must expire",
  );
  return {
    selectionStart,
    selectionFirst,
    reversalBefore,
    reversalAfter,
    reversalElapsed,
    selection,
    filtered,
    restored,
    opening,
    returning,
    reversalOpacity,
    returnOpacity,
    scroll,
  };
}

export async function verifyReducedTableMotion() {
  check(
    matchMedia("(prefers-reduced-motion: reduce)").matches,
    "Enable reduced motion first",
  );
  const target = rows()[1];
  if (!target) throw new Error("Missing selection target");
  act(() => target.click());
  await wait(50);
  check(
    paint().getAnimations().length === 0,
    "Reduced motion skips selection movement",
  );
  context();
  command("Solo");
  await wait(50);
  check(
    rows().every((row) => row.getAnimations().length === 0),
    "Reduced motion skips row movement",
  );
  check(
    !document.querySelector("[data-motion-exit]"),
    "Reduced motion retains no exit paint",
  );
  context();
  command("Show all branches");
  await wait(50);
  const last = rows().at(-1);
  if (!last) throw new Error("Missing fixture commit");
  act(() => last.click());
  await openCode();
  back();
  await wait(50);
  check(
    !document.querySelector("[data-motion-exit]"),
    "Reduced pane navigation is immediate",
  );
  return { passed: true };
}
