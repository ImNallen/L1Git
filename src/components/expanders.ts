const EXPANDER = "[data-expand-button]";

const expandersIn = (root: ShadowRoot) => [
  ...root.querySelectorAll<HTMLElement>(EXPANDER),
];

/** Pierre hides some of them. */
const shown = (button: HTMLElement) => button.getClientRects().length > 0;

function nameOf(button: HTMLElement): string {
  const lines = button
    .closest("[data-separator]")
    ?.querySelector("[data-unmodified-lines]")?.textContent;
  // Pierre has no count where a file may go on.
  const all = lines && /^\d/.test(lines) ? lines : "more unmodified lines";
  // Pierre has two directions where it shows a part at a time.
  if (!button.closest("[data-separator-multi-button]")) return `Show ${all}`;
  if (button.hasAttribute("data-expand-up")) return `Show the first of ${all}`;
  return button.hasAttribute("data-expand-down")
    ? `Show the last of ${all}`
    : `Show ${all}`;
}

const heard = new WeakSet<ShadowRoot>();
/** Where a key expanded something, which Pierre then draws again. */
let pressed: { root: ShadowRoot; at: number } | null = null;

function pressByKey(event: Event) {
  if (!(event instanceof KeyboardEvent) || !(event.target instanceof Element))
    return;
  const button = event.target.closest<HTMLElement>(EXPANDER);
  const root = button?.getRootNode();
  if (!button || !(root instanceof ShadowRoot)) return;
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  pressed = { root, at: expandersIn(root).filter(shown).indexOf(button) };
  button.click();
}

/** Pierre draws hunk expanders for a pointer only: without a name, and out of the tab order. */
export function keyExpanders({ shadowRoot: root }: HTMLElement) {
  if (!root) return;
  const buttons = expandersIn(root);
  for (const button of buttons) {
    button.tabIndex = 0;
    button.setAttribute("aria-label", nameOf(button));
  }
  if (!heard.has(root)) {
    heard.add(root);
    root.addEventListener("keydown", pressByKey);
  }
  if (pressed?.root !== root || root.activeElement !== null) return;
  const { activeElement } = document;
  if (activeElement !== document.body && activeElement !== root.host) {
    pressed = null;
    return;
  }
  const near = buttons.filter(shown);
  const next =
    near[Math.min(pressed.at, near.length - 1)] ??
    root.host.closest<HTMLElement>(".file-diff-scroll");
  next?.focus({ preventScroll: true });
}
