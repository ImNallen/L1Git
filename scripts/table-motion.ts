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
