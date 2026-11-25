import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MarkdownReader } from "./reader";
import type { Answer, Question, Start } from "./reader";
import type { Tree } from "./tree";

/** A worker that answers when it is told to. */
class Puppet {
  asked: string[] = [];
  stopped = false;
  constructor(
    readonly heard: (answer: Answer) => void,
    readonly failed: () => void,
  ) {}
  ask = ({ text }: Question) => {
    this.asked.push(text);
  };
  stop = () => {
    this.stopped = true;
  };
  ready = () => this.heard("ready");
  answer = (tree: Tree | null = read("")) => this.heard({ tree });
}

const read = (text: string, size = text.length, weight = 1): Tree => ({
  pieces: [text],
  size,
  weight,
});

let workers: Puppet[];
let reader: MarkdownReader;
let done: Record<string, Tree | null>;
const start: Start = (heard, failed) => {
  const worker = new Puppet(heard, failed);
  workers.push(worker);
  return worker;
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", globalThis);
  workers = [];
  done = {};
  reader = new MarkdownReader(start);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const ask = (text: string, isWanted = () => false, base = "https://a.test/") =>
  reader.read({ text, base }, isWanted, (tree) => {
    done[text] = tree;
  });

it("asks one at a time, once the worker is ready", () => {
  ask("a");
  ask("b");
  expect(workers).toHaveLength(1);
  expect(workers[0]!.asked).toEqual([]);
  workers[0]!.ready();
  expect(workers[0]!.asked).toEqual(["a"]);
  workers[0]!.answer(read("A"));
  expect(done).toEqual({ a: read("A") });
  expect(workers[0]!.asked).toEqual(["a", "b"]);
  workers[0]!.answer(null);
  expect(done).toEqual({ a: read("A"), b: null });
});

it("starts early when it is told to, and once", () => {
  reader.warm();
  reader.warm();
  expect(workers).toHaveLength(1);
  workers[0]!.ready();
  ask("a");
  expect(workers[0]!.asked).toEqual(["a"]);
});

it("gives up a text that takes long, and goes on with a new worker", () => {
  ask("a");
  ask("slow");
  ask("b");
  workers[0]!.ready();
  workers[0]!.answer(read("A"));
  vi.advanceTimersByTime(299);
  expect(workers[0]!.stopped).toBe(false);
  vi.advanceTimersByTime(2);
  expect(workers[0]!.stopped).toBe(true);
  expect(done).toEqual({ a: read("A"), slow: null });
  expect(workers).toHaveLength(2);
  workers[1]!.ready();
  expect(workers[1]!.asked).toEqual(["b"]);
  workers[0]!.answer(read("late"));
  expect(done).not.toHaveProperty("b");
  workers[1]!.answer(read("B"));
  expect(done).toMatchObject({ b: read("B") });
});

it("replaces a worker that read something heavy", () => {
  ask("a");
  ask("heavy");
  ask("b");
  workers[0]!.ready();
  vi.advanceTimersByTime(40);
  workers[0]!.answer(read("A"));
  expect(workers[0]!.stopped).toBe(false);
  vi.advanceTimersByTime(60);
  workers[0]!.answer(read("H"));
  expect(workers[0]!.stopped).toBe(true);
  workers[1]!.ready();
  workers[1]!.answer(read("B"));
  expect(done).toEqual({ a: read("A"), heavy: read("H"), b: read("B") });
});

it("stops a worker that has had nothing to read for a while", () => {
  ask("a");
  workers[0]!.ready();
  vi.advanceTimersByTime(20);
  workers[0]!.answer();
  vi.advanceTimersByTime(9_000);
  ask("b");
  vi.advanceTimersByTime(20);
  workers[0]!.answer();
  vi.advanceTimersByTime(9_000);
  expect(workers[0]!.stopped).toBe(false);
  vi.advanceTimersByTime(1_020);
  expect(workers[0]!.stopped).toBe(true);
  ask("c");
  workers[1]!.ready();
  expect(workers[1]!.asked).toEqual(["c"]);
});

it("counts no time before the worker is ready, and none between texts", () => {
  ask("a");
  vi.advanceTimersByTime(5_000);
  workers[0]!.ready();
  vi.advanceTimersByTime(40);
  workers[0]!.answer(read("A"));
  vi.advanceTimersByTime(5_000);
  ask("b");
  vi.advanceTimersByTime(40);
  workers[0]!.answer(read("B"));
  vi.advanceTimersByTime(5_000);
  expect(workers[0]!.stopped).toBe(false);
  expect(done).toEqual({ a: read("A"), b: read("B") });
});

it("hears an answer that came while the window was busy", () => {
  ask("a");
  workers[0]!.ready();
  setTimeout(() => workers[0]!.answer(read("A")), 300);
  vi.advanceTimersByTime(5_000);
  expect(done).toEqual({ a: read("A") });
});

it("reads what is wanted first, whenever that changes", () => {
  let wanted = "c";
  for (const text of ["a", "b", "c", "d"]) ask(text, () => wanted === text);
  workers[0]!.ready();
  wanted = "d";
  workers[0]!.answer();
  workers[0]!.answer();
  workers[0]!.answer();
  workers[0]!.answer();
  expect(workers[0]!.asked).toEqual(["c", "d", "a", "b"]);
});

it("forgets what nobody waits for", () => {
  const stops = ["a", "b", "c"].map((text) => ask(text));
  workers[0]!.ready();
  stops[0]!();
  stops[1]!();
  workers[0]!.answer();
  workers[0]!.answer();
  expect(workers[0]!.asked).toEqual(["a", "c"]);
  expect(Object.keys(done)).toEqual(["c"]);
});

it("keeps what it read, by text and base", () => {
  ask("a");
  workers[0]!.ready();
  workers[0]!.answer(read("A"));
  done = {};
  ask("a");
  expect(done).toEqual({ a: read("A") });
  ask("a", undefined, "https://b.test/");
  expect(workers[0]!.asked).toEqual(["a", "a"]);
});

it("remembers what it gave up", () => {
  ask("slow");
  workers[0]!.ready();
  vi.advanceTimersByTime(1_000);
  done = {};
  ask("slow");
  expect(done).toEqual({ slow: null });
});

it("asks once for a text that is there twice", () => {
  ask("a");
  ask("a");
  workers[0]!.ready();
  workers[0]!.answer(read("A"));
  expect(workers[0]!.asked).toEqual(["a"]);
});

it("keeps the latest only, down to a number of them", () => {
  ask("first");
  workers[0]!.ready();
  workers[0]!.answer();
  for (let at = 0; at < 499; at += 1) {
    ask(`${at}`);
    workers[0]!.answer();
  }
  const asked = () => workers[0]!.asked.length;
  ask("first");
  expect(asked()).toBe(500);
  ask("new");
  workers[0]!.answer();
  ask("first");
  expect(asked()).toBe(501);
  ask("0");
  expect(asked()).toBe(502);
});

it("keeps the latest only, down to a number of characters", () => {
  ask("a");
  workers[0]!.ready();
  workers[0]!.answer(read("A", 5_000_000));
  ask("b");
  workers[0]!.answer(read("B", 4_000_000));
  ask("b");
  expect(workers[0]!.asked).toEqual(["a", "b"]);
  ask("a");
  expect(workers[0]!.asked).toEqual(["a", "b", "a"]);
});

it("counts the pieces of a text, too", () => {
  ask("a");
  workers[0]!.ready();
  workers[0]!.answer(read("A", 1, 100_000));
  ask("b");
  workers[0]!.answer(read("B", 1, 100_000));
  ask("a");
  expect(workers[0]!.asked).toEqual(["a", "b", "a"]);
});

it("shows texts as they were written when there is no worker", () => {
  reader = new MarkdownReader(() => {
    throw new Error("No workers here.");
  });
  ask("a");
  ask("b");
  expect(done).toEqual({ a: null, b: null });
});

it("shows texts as they were written when the worker does not load", () => {
  ask("a");
  ask("b");
  workers[0]!.failed();
  ask("c");
  expect(done).toEqual({ a: null, b: null, c: null });
  expect(workers).toHaveLength(1);
});

it("goes on with a new worker when one breaks", () => {
  ask("a");
  ask("b");
  workers[0]!.ready();
  workers[0]!.failed();
  expect(done).toEqual({ a: null });
  workers[1]!.ready();
  workers[1]!.answer(read("B"));
  expect(done).toEqual({ a: null, b: read("B") });
});
