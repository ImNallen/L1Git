import { animate, motionAllowed } from "./motion";

const paintProperties =
  `display position box-sizing width height min-width min-height max-width max-height margin padding border border-radius background color opacity font white-space text-align text-decoration line-height letter-spacing vertical-align overflow overflow-x overflow-y flex flex-direction flex-wrap align-items justify-content gap grid-template-columns grid-template-rows grid-column grid-row align-self justify-self inset z-index transform translate transform-origin clip-path fill stroke stroke-width visibility box-shadow outline list-style contain mask-image mask-size mask-position mask-repeat content text-overflow tab-size word-break border-collapse table-layout stroke-linecap stroke-linejoin`.split(
    " ",
  );

function parentElement(element: Element): Element | null {
  const root = element.getRootNode();
  return (
    element.parentElement ?? (root instanceof ShadowRoot ? root.host : null)
  );
}

/** A paint-only copy. Custom elements become plain boxes, never another renderer. */
type ScrollCopy = { copy: Element; left: number; top: number };

function copyPaint(source: Element, offsets: ScrollCopy[]): Element {
  const reference =
    source.localName === "use" ? source.getAttribute("href") : null;
  const scope = source.getRootNode();
  const symbol =
    reference?.startsWith("#") &&
    (scope instanceof ShadowRoot || scope instanceof Document)
      ? scope.getElementById(reference.slice(1))
      : null;
  const copy = symbol
    ? document.createElementNS("http://www.w3.org/2000/svg", "g")
    : source.localName.includes("-")
      ? document.createElement("div")
      : source.cloneNode(false);
  if (!(copy instanceof Element)) throw new Error("Expected an element");
  copy.removeAttribute("id");
  copy.removeAttribute("role");
  copy.removeAttribute("class");
  copy.removeAttribute("autofocus");
  copy.removeAttribute("tabindex");
  if (copy instanceof HTMLElement || copy instanceof SVGElement) {
    const style = getComputedStyle(source);
    copy.style.cssText = paintProperties
      .map((property) => `${property}:${style.getPropertyValue(property)}`)
      .join(";");
    copy.style.setProperty("animation", "none");
    copy.style.setProperty("transition", "none");
    copy.style.setProperty("pointer-events", "none");
  }
  offsets.push({ copy, left: source.scrollLeft, top: source.scrollTop });
  const bounds = source.getBoundingClientRect();
  if (bounds.height && (bounds.bottom < 0 || bounds.top > window.innerHeight))
    return copy;
  if (symbol) {
    for (const child of symbol.childNodes) copy.append(child.cloneNode(true));
    return copy;
  }
  const pseudo = (name: "::before" | "::after") => {
    const style = getComputedStyle(source, name);
    if (
      style.content === "none" ||
      style.content === "normal" ||
      !style.content
    )
      return;
    const paint = document.createElement("span");
    paint.style.cssText = paintProperties
      .map((property) => `${property}:${style.getPropertyValue(property)}`)
      .join(";");
    if (style.content.startsWith('"') && style.content.endsWith('"'))
      paint.textContent = style.content.slice(1, -1);
    copy.append(paint);
  };
  if (source instanceof HTMLElement) pseudo("::before");
  const children = source.shadowRoot?.childNodes ?? source.childNodes;
  for (const child of children) {
    if (child instanceof Element) {
      if (["style", "script"].includes(child.localName)) continue;
      copy.append(copyPaint(child, offsets));
    } else copy.append(child.cloneNode());
  }
  if (source instanceof HTMLElement) pseudo("::after");
  return copy;
}

export function captureExit(element: HTMLElement, kind: string) {
  if (!motionAllowed()) return null;
  const rect = element.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const clip = {
    left: Math.max(0, rect.left),
    top: Math.max(0, rect.top),
    right: Math.min(window.innerWidth, rect.right),
    bottom: Math.min(window.innerHeight, rect.bottom),
  };
  for (
    let ancestor = parentElement(element);
    ancestor;
    ancestor = parentElement(ancestor)
  ) {
    const style = getComputedStyle(ancestor);
    const bounds = ancestor.getBoundingClientRect();
    if (/(hidden|auto|scroll|clip)/.test(style.overflowX)) {
      clip.left = Math.max(clip.left, bounds.left);
      clip.right = Math.min(clip.right, bounds.right);
    }
    if (/(hidden|auto|scroll|clip)/.test(style.overflowY)) {
      clip.top = Math.max(clip.top, bounds.top);
      clip.bottom = Math.min(clip.bottom, bounds.bottom);
    }
  }
  if (clip.right <= clip.left || clip.bottom <= clip.top) return null;
  const layer = document.createElement("div");
  layer.dataset.motionExit = kind;
  layer.inert = true;
  layer.setAttribute("aria-hidden", "true");
  layer.style.cssText = `position:fixed;pointer-events:none;overflow:hidden;z-index:100;left:${clip.left}px;top:${clip.top}px;width:${clip.right - clip.left}px;height:${clip.bottom - clip.top}px`;
  const offsets: ScrollCopy[] = [];
  const paint = copyPaint(element, offsets);
  if (!(paint instanceof HTMLElement)) return null;
  paint.style.cssText += `;position:absolute;margin:0;left:${rect.left - clip.left}px;top:${rect.top - clip.top}px;width:${rect.width}px;height:${rect.height}px;transform:none;translate:none;`;
  layer.append(paint);
  let timer = 0;
  let animation: Animation | undefined;
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  const scrolled = (event: Event) => {
    if (
      event.target instanceof Element &&
      event.target.closest("[data-motion-exit]")
    )
      return;
    dispose();
  };
  const dispose = () => {
    window.clearTimeout(timer);
    animation?.cancel();
    layer.remove();
    paint.replaceChildren();
    offsets.length = 0;
    window.removeEventListener("scroll", scrolled, true);
    window.removeEventListener("resize", dispose);
    media.removeEventListener("change", dispose);
  };
  const show = () => {
    if (!motionAllowed()) return dispose();
    if (layer.isConnected) return;
    document.body.append(layer);
    for (const offset of offsets) {
      offset.copy.scrollLeft = offset.left;
      offset.copy.scrollTop = offset.top;
    }
    window.addEventListener("scroll", scrolled, true);
    window.addEventListener("resize", dispose);
    media.addEventListener("change", dispose);
  };
  return {
    layer,
    paint,
    dispose,
    show,
    play(duration: number) {
      if (!motionAllowed()) return dispose();
      show();
      animation = animate(layer, [{ opacity: 1 }, { opacity: 0 }], duration);
      timer = window.setTimeout(dispose, duration + 50);
      animation?.finished.then(dispose, dispose);
    },
  };
}
