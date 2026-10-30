import { useEffect, type RefObject } from "react";

// The repository chevrons and hover-only visibility toggles stay out: arrows stand in for the first, the context menu for the second.
const ROW = "button:not(.repository-toggle, .branch-visibility)";
const SKIPPED = ".repository-toggle, .branch-visibility";

/**
 * Makes the sidebar one Tab stop. Up and Down step through its rows, Home and
 * End jump to the ends, Right expands and Left collapses or returns to the
 * repository.
 */
export function useRovingRows(container: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const root = container.current;
    if (!root) return;
    let current: HTMLElement | null = null;
    const rows = () => [...root.querySelectorAll<HTMLElement>(ROW)];

    function sync() {
      const all = rows();
      if (!current || !all.includes(current))
        current =
          all.find((row) => row.getAttribute("aria-current") === "true") ??
          all[0] ??
          null;
      for (const row of all) row.tabIndex = row === current ? 0 : -1;
      for (const skipped of root!.querySelectorAll<HTMLElement>(SKIPPED))
        skipped.tabIndex = -1;
    }

    // The toggle that expands a row: the row itself, or a repository's chevron.
    const toggleOf = (row: HTMLElement) =>
      row.hasAttribute("aria-expanded")
        ? row
        : row.classList.contains("repository-open")
          ? row.parentElement?.querySelector<HTMLElement>(".repository-toggle")
          : null;

    function onFocusIn(event: FocusEvent) {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !target.matches(ROW)) return;
      current = target;
      sync();
    }

    function onKeyDown(event: KeyboardEvent) {
      const target = event.target;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
        return;
      if (!(target instanceof HTMLElement) || !target.matches(ROW)) return;
      const all = rows();
      const at = all.indexOf(target);
      const toggle = toggleOf(target);
      const expanded = toggle?.getAttribute("aria-expanded");
      let next: HTMLElement | null | undefined;
      switch (event.key) {
        case "ArrowDown":
          next = all[at + 1];
          break;
        case "ArrowUp":
          next = all[at - 1];
          break;
        case "Home":
          next = all[0];
          break;
        case "End":
          next = all.at(-1);
          break;
        case "ArrowRight":
          if (expanded === "false") toggle?.click();
          else if (expanded === "true") next = all[at + 1];
          else return;
          break;
        case "ArrowLeft":
          if (expanded === "true") toggle?.click();
          else
            next = target
              .closest(".repository-group")
              ?.querySelector<HTMLElement>(".repository-open");
          break;
        default:
          return;
      }
      event.preventDefault();
      if (next && next !== target) next.focus();
    }

    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { childList: true, subtree: true });
    root.addEventListener("focusin", onFocusIn);
    root.addEventListener("keydown", onKeyDown);
    return () => {
      observer.disconnect();
      root.removeEventListener("focusin", onFocusIn);
      root.removeEventListener("keydown", onKeyDown);
    };
  }, [container]);
}
