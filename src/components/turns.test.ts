// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installSight } from "../test/sight";
import { Turns } from "./turns";

let sight: ReturnType<typeof installSight>;
let turns: Turns;
let now: number;
/** What happened, such as "+a" for what is shown and "-a" for what is put away. */
let log: string[];
beforeEach(() => {
  sight = installSight();
  now = 0;
  log = [];
  vi.spyOn(performance, "now").mockImplementation(() => now);
  turns = new Turns();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function add(name: string, { weight = 1, takes = 0 } = {}) {
  const place = document.body.appendChild(document.createElement("div"));
  place.append(document.createElement("button"), name);
  let isShown = false;
  const leave = turns.join({
    place,
    next: () =>
      isShown
        ? null
        : {
            weight,
            show: () => {
              isShown = true;
              now += takes;
              log.push(`+${name}`);
            },
          },
    putAway: () => {
      isShown = false;
      log.push(`-${name}`);
    },
  });
  return { place, leave };
}
const taken = () => log.splice(0).join(" ");

it("shows what is near first, and then the others in order", () => {
  const [, , c, d] = ["a", "b", "c", "d"].map((name) => add(name));
  sight.see(true, c!.place, d!.place);
  sight.frame();
  expect(taken()).toBe("+c +d +a +b");
});

it("shows only as much in a frame as there is time for", () => {
  for (const name of ["a", "b", "c", "d"]) add(name, { takes: 5 });
  sight.frame();
  expect(taken()).toBe("+a +b");
  sight.frame();
  expect(taken()).toBe("+c +d");
  sight.frame();
  expect(sight.frame(), "nothing is left to do").toBe(false);
});

it("shows one thing at least, however long it takes", () => {
  for (const name of ["a", "b"]) add(name, { takes: 500 });
  sight.frame();
  expect(taken()).toBe("+a");
  sight.frame();
  expect(taken()).toBe("+b");
});

it("looks at what is near again in each frame", () => {
  const places = ["a", "b", "c"].map((name) => add(name, { takes: 9 }).place);
  sight.frame();
  sight.see(true, places[2]!);
  sight.frame();
  expect(taken()).toBe("+a +c");
});

it("shows nothing of what left", () => {
  const { place, leave } = add("a");
  leave();
  sight.frame();
  expect(taken()).toBe("");
  expect(sight.observed.has(place)).toBe(false);
});

describe("with more than there is room for", () => {
  const HALF = 20_000;

  it("shows what is far only as long as there is room", () => {
    add("a", { weight: HALF });
    add("b", { weight: HALF });
    const { place } = add("c", { weight: HALF });
    add("d", { weight: HALF });
    sight.frame();
    expect(taken()).toBe("+a +b");
    sight.see(true, place);
    sight.frame();
    expect(taken()).toBe("+c -a");
  });

  it("puts nothing away for what fits", () => {
    const { place } = add("a", { weight: HALF });
    add("b", { weight: HALF });
    sight.see(true, place);
    sight.frame();
    sight.see(false, place);
    expect(taken()).toBe("+a +b");
  });

  it.each([
    ["focused", (place: Element) => place.querySelector("button")!.focus()],
    ["selected", (place: Element) => getSelection()!.selectAllChildren(place)],
  ])("keeps what is %s", (_, hold) => {
    const { place } = add("a", { weight: HALF });
    add("b", { weight: HALF });
    sight.frame();
    hold(place);
    const c = add("c", { weight: HALF });
    sight.see(true, c.place);
    sight.frame();
    expect(taken()).toBe("+a +b +c -b");
  });

  it("has room again for what comes near, and once something left", () => {
    const a = add("a", { weight: HALF });
    add("b", { weight: HALF });
    add("c", { weight: HALF });
    sight.frame();
    expect(taken()).toBe("+a +b");
    a.leave();
    turns.wake();
    sight.frame();
    expect(taken()).toBe("+c");
  });
});
