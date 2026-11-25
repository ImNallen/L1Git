// @vitest-environment happy-dom
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DiffStyle } from "../domain/lineSelection";
import { KeepDiffPlace } from "./KeepDiffPlace";
import type { DrawnPart } from "./useDiffSteps";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

const VIEW = 300;
const LINE = 20;

let host: HTMLElement;
let root: Root;
let resized: () => void;
let frames: (() => void)[];
let isShown: boolean;
/** How high what is above the lines is. */
let above: number;
const body = createRef<HTMLDivElement>();
const instance = {
  setMetrics: vi.fn(),
  rerender: vi.fn(),
  getLinePosition: (line: number) => ({ top: line * LINE, height: LINE }),
};
const scroller = () => body.current!.firstElementChild as HTMLElement;
const node = () => scroller().querySelector<HTMLElement>("p")!;
const parts = (): DrawnPart[] => [
  { node: node(), instance: instance as unknown as DrawnPart["instance"] },
];

function draw(from: number, to: number) {
  const shadow = node().shadowRoot ?? node().attachShadow({ mode: "open" });
  shadow.replaceChildren(
    ...Array.from({ length: to - from }, (_, at) => {
      const line = document.createElement("i");
      line.dataset.line = String(from + at);
      return line;
    }),
  );
}
const top = (line: number) => above + line * LINE - scroller().scrollTop;
const frame = () => {
  const now = frames;
  frames = [];
  for (const each of now) each();
};
function scroll(to: number) {
  scroller().scrollTop = to;
  scroller().dispatchEvent(new Event("scroll"));
}

beforeEach(() => {
  frames = [];
  isShown = true;
  above = 0;
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
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) =>
    frames.push(callback),
  );
  vi.stubGlobal("cancelAnimationFrame", () => {
    frames = [];
  });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      if (this === scroller())
        return { top: 0, bottom: VIEW, height: VIEW } as DOMRect;
      const line = (this as HTMLElement).dataset.line;
      const at =
        line === undefined ? above - scroller().scrollTop : top(Number(line));
      return { top: at, bottom: at + LINE, height: LINE } as DOMRect;
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
    () => (body.current?.hidden ? 0 : VIEW),
  );
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

const render = (diffStyle: DiffStyle = "unified") =>
  act(() =>
    root.render(
      <>
        <div ref={body} hidden={!isShown}>
          <div className="file-diff-scroll">
            <div>
              <p />
            </div>
          </div>
        </div>
        <KeepDiffPlace
          startsAt={() => null}
          onLeave={() => {}}
          body={body}
          parts={parts}
          isShown={isShown}
          diffStyle={diffStyle}
        />
      </>,
    ),
  );

it("keeps the place when what is above it grows", async () => {
  await render();
  draw(0, 100);
  scroll(410);
  expect(top(20)).toBe(-10);
  above = 70;
  resized();
  expect(top(20)).toBe(-10);
});

it("shows what comes at the beginning", async () => {
  await render();
  draw(0, 100);
  scroll(0);
  above = 70;
  resized();
  expect(scroller().scrollTop).toBe(0);
});

it("comes back to a line that is drawn only after some frames", async () => {
  await render();
  draw(0, 100);
  scroll(410);
  isShown = false;
  await render();
  scroller().scrollTop = 0;
  resized();
  draw(0, 5);
  isShown = true;
  above = 300;
  await render();
  expect(instance.setMetrics).toHaveBeenCalledTimes(1);
  expect(instance.rerender).toHaveBeenCalledTimes(1);
  expect(scroller().style.visibility, "no other place flashes by").toBe(
    "hidden",
  );
  frame();
  expect(top(20), "where Pierre reckons it is").toBe(-10);
  above = 340;
  draw(15, 60);
  frame();
  frame();
  expect(top(20)).toBe(-10);
  for (let more = 0; more < 5; more += 1) frame();
  expect(scroller().style.visibility).toBe("");
  expect(frames).toEqual([]);
});

it("keeps the line from one layout to the other, until the reader scrolls", async () => {
  await render();
  draw(0, 100);
  scroll(410);
  await render("split");
  above = 200;
  frame();
  expect(top(20)).toBe(-10);
  scroller().dispatchEvent(new Event("wheel"));
  expect(frames).toEqual([]);
  scroll(800);
  above = 250;
  resized();
  expect(top(30)).toBe(0);
});
