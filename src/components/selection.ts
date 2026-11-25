import { DIFFS_TAG_NAME } from "@pierre/diffs";

type SelectingRoot = ShadowRoot & { getSelection?: () => Selection | null };

const shadowRootsIn = (element: HTMLElement) =>
  [...element.querySelectorAll(DIFFS_TAG_NAME)].flatMap(
    ({ shadowRoot }) => shadowRoot ?? [],
  );

/** The ends of what is selected, also within Pierre's shadow roots. */
function selectedRanges(roots: ShadowRoot[]): AbstractRange[] {
  const selection = document.getSelection();
  if (!selection || selection.rangeCount === 0) return [];
  // Chromium has had this one for longer.
  const inside = roots.flatMap((root: SelectingRoot) => {
    const own = root.getSelection?.();
    return own && own.rangeCount > 0 ? own.getRangeAt(0) : [];
  });
  // Types say that every browser has it. Safari 17 takes the roots one by one.
  const composed = selection.getComposedRanges as
    | ((...roots: object[]) => StaticRange[])
    | undefined;
  if (!composed) return [...inside, selection.getRangeAt(0)];
  try {
    return [...inside, ...composed.call(selection, { shadowRoots: roots })];
  } catch {
    return [...inside, ...composed.apply(selection, roots)];
  }
}

/** Whether the reader has selected something in it. */
export function hasSelection(element: HTMLElement): boolean {
  const roots = shadowRootsIn(element);
  return selectedRanges(roots).some(
    ({ collapsed, startContainer, endContainer }) =>
      !collapsed &&
      [element, ...roots].some(
        (each) => each.contains(startContainer) || each.contains(endContainer),
      ),
  );
}
