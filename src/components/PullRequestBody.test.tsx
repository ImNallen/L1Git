// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readMarkdown } from "../markdown/readMarkdown";
import type { Tree } from "../markdown/tree";
import { installSight } from "../test/sight";
import { Body } from "./PullRequestBody";
import { Turns, TurnsContext } from "./turns";

type Reading = {
  text: string;
  isWanted: () => boolean;
  done: (tree: Tree | null) => void;
};
const readings = vi.hoisted(() => new Set<Reading>());
vi.mock("../markdown/markdownReader", () => ({
  markdownReader: {
    read: (
      { text }: Reading,
      isWanted: Reading["isWanted"],
      done: Reading["done"],
    ) => {
      const reading = { text, isWanted, done };
      readings.add(reading);
      return () => readings.delete(reading);
    },
  },
}));
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

let sight: ReturnType<typeof installSight>;
let host: HTMLElement;
let root: Root;
let turns: Turns;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  sight = installSight();
  turns = new Turns();
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  readings.clear();
  vi.useRealTimers();
});

const show = (text: string) =>
  act(() =>
    root.render(
      <TurnsContext value={turns}>
        <Body text={text} />
      </TurnsContext>,
    ),
  );
const body = () => host.querySelector<HTMLElement>(".markdown")!;
const come = () => act(() => sight.see(true, body()));
const frame = () => act(() => void sight.frame());
const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms));
const read = (text: string, tree: Tree | null = readMarkdown(text, "")) =>
  act(() => {
    for (const reading of readings)
      if (reading.text === text) reading.done(tree);
  });
const written = () =>
  [...host.querySelectorAll(".markdown-plain pre")].map(
    ({ innerHTML }) => innerHTML,
  );

it("takes space, and nothing else, until its turn", async () => {
  await show("**a**");
  expect(body().innerHTML).toBe("");
  expect(body().style.minHeight).toBe("21px");
  await read("**a**");
  expect(body().innerHTML).toBe("");
  await frame();
  expect(body().innerHTML).toBe("<p><strong>a</strong></p>");
  expect(body().style.minHeight).toBe("");
});

it("is not shown as it was written when it is read soon", async () => {
  await show("**a**");
  await come();
  await wait(99);
  await frame();
  expect(body().innerHTML).toBe("");
  await read("**a**");
  await wait(1_000);
  await frame();
  expect(written()).toEqual([]);
  expect(host.textContent).toBe("a");
});

it("is shown as it was written once it is near and that takes long", async () => {
  await show("**a**");
  await wait(100);
  await frame();
  expect(body().innerHTML, "far").toBe("");
  await come();
  await frame();
  expect(written()).toEqual(["**a**"]);
  await read("**a**");
  await frame();
  expect(body().innerHTML).toBe("<p><strong>a</strong></p>");
});

it("says that nothing is to be seen only of a whole text", async () => {
  const hidden = `<!-- ${"a ".repeat(10_000)}-->`;
  const start = "<!-- a -->\n";
  const text = `${start}${hidden}\nb`;
  await show(text);
  await read(start.trim());
  await frame();
  expect(host.textContent).toBe("Show all");
  await act(() => host.querySelector("button")!.click());
  await frame();
  expect(host.textContent, "not yet read").toBe("Show less");
  await read(text);
  await frame();
  expect(host.textContent).toBe("bShow less");
  await show(hidden);
  await read(hidden);
  await frame();
  expect(host.textContent).toBe("No visible text.Show less");
});

it("is wanted once it is near", async () => {
  await show("a");
  const [reading] = readings;
  expect(reading!.isWanted()).toBe(false);
  await come();
  expect(reading!.isWanted()).toBe(true);
});

it("shows a text that was given up in parts that can be laid out", async () => {
  const text = `${"a".repeat(300)}\n${"b ".repeat(950)}\n\n**c**`;
  await show(text);
  await read(text, null);
  await frame();
  const parts = written();
  expect(parts).toHaveLength(3);
  expect(parts[0]!.split("<wbr>").map(({ length }) => length)).toEqual([
    120, 120, 60,
  ]);
  expect(parts.slice(1)).toEqual([
    "b ".repeat(500),
    `${"b ".repeat(450)}\n\n**c**`,
  ]);
});

it("shows as much of it in a frame as there is time for", async () => {
  const now = vi.spyOn(performance, "now").mockReturnValue(0);
  const text = `${"a".repeat(999)}\n`.repeat(3);
  await show(text);
  await read(text, null);
  now.mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(9);
  await frame();
  expect(written()).toHaveLength(1);
  expect(body().style.minHeight).toBe("798px");
  now.mockReturnValue(0);
  await frame();
  await frame();
  expect(written()).toHaveLength(3);
  expect(body().style.minHeight).toBe("");
  now.mockRestore();
});

it("keeps the text before until the next one is read, in the view", async () => {
  await show("one");
  await come();
  await read("one");
  await frame();
  await show("two");
  await frame();
  expect(host.textContent).toBe("one");
  expect([...readings].map(({ text }) => text)).toEqual(["two"]);
  await read("two");
  await frame();
  expect(host.textContent).toBe("two");
});

it("keeps no text before out of the view", async () => {
  await show("one");
  await read("one");
  await frame();
  expect(host.textContent).toBe("one");
  await show("two");
  await act(() => turns.wake());
  await frame();
  expect(host.textContent).toBe("");
  await read("two", { ...readMarkdown("two", ""), weight: 50_000 });
  await frame();
  expect(host.textContent, "no room while it is far").toBe("");
  await come();
  await frame();
  expect(host.textContent).toBe("two");
});

it("stops reading when it goes", async () => {
  await show("a");
  expect(readings.size).toBe(1);
  await act(() => root.render(null));
  expect(readings.size).toBe(0);
  await wait(1_000);
  await frame();
  expect(host.textContent).toBe("");
});

it("takes the same space when it is put away, and comes back", async () => {
  await show("a");
  await read("a", { ...readMarkdown("a", ""), weight: 50_000 });
  await frame();
  expect(body().innerHTML, "no room while it is far").toBe("");
  await come();
  await frame();
  expect(host.textContent).toBe("a");
  body().getBoundingClientRect = () => ({ height: 345 }) as DOMRect;
  await act(() => sight.see(false, body()));
  await frame();
  expect(body().innerHTML).toBe("");
  expect(body().style.minHeight).toBe("345px");
  await come();
  await frame();
  expect(host.textContent).toBe("a");
});
