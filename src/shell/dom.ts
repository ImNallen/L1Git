export function focusedElement(): Element | null {
  let focused = document.activeElement;
  while (focused?.shadowRoot?.activeElement)
    focused = focused.shadowRoot.activeElement;
  return focused;
}

function shownElement(element: Element | null): element is HTMLElement {
  return (
    element instanceof HTMLElement &&
    element !== document.body &&
    element.isConnected &&
    element.getClientRects().length > 0
  );
}

export function focusIsShown(): boolean {
  return shownElement(focusedElement());
}

export function returnFocus(back: Element | null, fallback: () => void) {
  if (shownElement(back)) back.focus({ preventScroll: true });
  if (!shownElement(back) || focusedElement() !== back) fallback();
}
