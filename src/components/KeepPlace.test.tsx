// @vitest-environment happy-dom
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { KeepPlace } from "./KeepPlace";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

const VIEW = 300;
type Entry = { name: string; height: number };

let host: HTMLElement;
let root: Root;
let resized: () => void;
const panel = createRef<HTMLDivElement>();

/** Entries are laid out one below the other, in a panel that scrolls. */
function topOf(entry: Element): number {
  let top = -panel.current!.scrollTop;
  for (const each of panel.current!.children) {
    if (each === entry) return top;
    top += Number(each.getAttribute("data-height"));
  }
  return 0;
}
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resized = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      const top = this === panel.current ? 0 : topOf(this);
      return { left: 0, top, width: 100, height: VIEW } as DOMRect;
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.hidden ? 0 : VIEW;
    },
  );
  document.elementsFromPoint = (_, y) =>
    [...panel.current!.children].filter((entry) => {
      const top = topOf(entry);
      return top <= y && y < top + Number(entry.getAttribute("data-height"));
    });
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

const show = (entries: readonly Entry[], hidden = false) =>
  act(() =>
    root.render(
      <>
        <div ref={panel} hidden={hidden}>
          {entries.map(({ name, height }) => (
            <p key={name} className="entry" data-height={height}>
              {name}
            </p>
          ))}
        </div>
        <KeepPlace panel={panel} />
      </>,
    ),
  );
const entry = (name: string) =>
  [...panel.current!.children].find(({ textContent }) => textContent === name)!;
function scroll(top: number) {
  panel.current!.scrollTop = top;
  panel.current!.dispatchEvent(new Event("scroll"));
}
const entries = ["a", "b", "c", "d"].map((name) => ({ name, height: 200 }));
const [a, b, c, d] = entries as [Entry, Entry, Entry, Entry];

it("keeps the place when entries above come and go", async () => {
  await show(entries);
  scroll(390);
  await show([{ name: "new", height: 70 }, ...entries]);
  expect(topOf(entry("c"))).toBe(10);
  await show([b, c, d]);
  expect(topOf(entry("c"))).toBe(10);
});

it("keeps the place when an entry above is shown", async () => {
  await show(entries);
  scroll(390);
  entry("a").setAttribute("data-height", "900");
  resized();
  expect(topOf(entry("c"))).toBe(10);
  expect(panel.current!.scrollTop).toBe(1_090);
});

it("keeps the place when the panel was cut short for a moment", async () => {
  await show(entries);
  scroll(390);
  panel.current!.scrollTop = 300;
  entry("a").setAttribute("data-height", "900");
  resized();
  expect(topOf(entry("c"))).toBe(10);
});

it("keeps the place in a panel that changes while it is hidden", async () => {
  await show(entries);
  scroll(390);
  await show(entries, true);
  resized();
  await show([{ ...a, height: 900 }, b, c, d], true);
  resized();
  await show([{ ...a, height: 900 }, b, c, d]);
  expect(topOf(entry("c"))).toBe(10);
  entry("b").setAttribute("data-height", "300");
  resized();
  expect(topOf(entry("c"))).toBe(10);
});

it("follows the reader, and stays at the beginning", async () => {
  await show(entries);
  scroll(390);
  scroll(150);
  entry("a").setAttribute("data-height", "300");
  resized();
  expect(topOf(entry("b")), "the nearest to the top").toBe(50);
  scroll(0);
  await show([{ name: "new", height: 70 }, ...entries]);
  expect(panel.current!.scrollTop).toBe(0);
});
