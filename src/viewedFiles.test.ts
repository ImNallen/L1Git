import { expect, it, vi } from "vitest";
import { createViewedFiles } from "./viewedFiles";

const KEY = "l1git.viewed.v1";
const pull = "octo/pin#1";
const mark = (name: string, isViewed = true) => [
  { pull, mark: name, isViewed },
];
function fakeStorage(saved: string | null = null) {
  const items = new Map(saved === null ? [] : [[KEY, saved]]);
  return {
    isFull: false,
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem(key: string, value: string) {
      if (this.isFull) throw new DOMException("full", "QuotaExceededError");
      items.set(key, value);
    },
  };
}
const marksOf = (store: ReturnType<typeof createViewedFiles>) =>
  store.read().pulls.flatMap(({ marks }) => marks);

it("saves a mark, and has it the next time", () => {
  const storage = fakeStorage();
  const store = createViewedFiles(storage);
  const listener = vi.fn();
  const stop = store.subscribe(listener);
  expect(store.mark(mark("a"))).toBeNull();
  expect(listener).toHaveBeenCalledOnce();
  stop();
  expect(storage.items.get(KEY)).toBe(
    '{"version":1,"pulls":[{"pull":"octo/pin#1","marks":["a"]}]}',
  );
  const next = createViewedFiles(storage);
  next.look();
  expect(marksOf(next)).toEqual(["a"]);
  expect(listener).toHaveBeenCalledOnce();
});

it("keeps what another window marked since", () => {
  const storage = fakeStorage();
  const one = createViewedFiles(storage);
  const two = createViewedFiles(storage);
  two.look();
  one.mark(mark("a"));
  two.mark(mark("b"));
  one.mark(mark("c"));
  two.mark(mark("a", false));
  one.look();
  expect(marksOf(one)).toEqual(["b", "c"]);
});

it("marks for the session when it can't save, and saves once it can", () => {
  const storage = fakeStorage();
  const store = createViewedFiles(storage);
  store.mark(mark("a"));
  storage.isFull = true;
  const unsaved = "Viewed files changed for this session. Could not save them.";
  expect(store.mark(mark("b"))).toBe(unsaved);
  expect(store.mark(mark("a", false))).toBe(unsaved);
  store.look();
  expect(marksOf(store)).toEqual(["b"]);
  createViewedFiles(storage);
  storage.isFull = false;
  const other = createViewedFiles(storage);
  other.mark(mark("c"));
  expect(store.mark(mark("d"))).toBeNull();
  expect(marksOf(store)).toEqual(["c", "b", "d"]);
  other.look();
  expect(marksOf(other)).toEqual(["c", "b", "d"]);
});

it("marks for the session without storage", () => {
  const denied = () => {
    throw new DOMException("denied", "SecurityError");
  };
  for (const storage of [null, { getItem: denied, setItem: denied }]) {
    const store = createViewedFiles(storage);
    store.look();
    expect(store.mark(mark("a"))).not.toBeNull();
    expect(store.mark(mark("b"))).not.toBeNull();
    expect(marksOf(store)).toEqual(["a", "b"]);
  }
});

it("leaves what a newer version wrote, and marks for the session", () => {
  const newer = '{"version":2,"pulls":{"octo/pin#1":["x"]}}';
  const storage = fakeStorage(newer);
  const store = createViewedFiles(storage);
  store.look();
  expect(store.mark(mark("a"))).not.toBeNull();
  expect(store.mark(mark("b"))).not.toBeNull();
  expect(marksOf(store)).toEqual(["a", "b"]);
  expect(storage.items.get(KEY)).toBe(newer);
});

it.each(['{"version":1,"pulls":[{', '{"version":0}', "[]", "null"])(
  "begins anew over %s",
  (saved) => {
    const store = createViewedFiles(fakeStorage(saved));
    store.look();
    expect(marksOf(store)).toEqual([]);
    expect(store.mark(mark("a"))).toBeNull();
    expect(marksOf(store)).toEqual(["a"]);
  },
);
