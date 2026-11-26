import { expect, it } from "vitest";
import { createReadQueue } from "./pullRequestQueue";
import type { ListRequest } from "./pullRequestQueue";
import { rootSchema } from "./domain/repository";

const open = (name: string): ListRequest => ({
  repository: {
    key: name,
    name,
    root: rootSchema.parse(`/work/${name}`),
    github: { owner: "octo", repo: name },
  },
  list: "open",
});
const all = (...names: string[]) => names.map(open);
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup() {
  const started: string[] = [];
  const ends = new Map<string, (passed: boolean) => void>();
  const queue = createReadQueue(({ repository }) => {
    started.push(repository.name);
    return new Promise((resolve) => ends.set(repository.name, resolve));
  });
  return {
    queue,
    started,
    end(name: string, passed = true) {
      ends.get(name)?.(passed);
      return settled();
    },
  };
}

it("reads the first alone, then four at a time, in the order asked", async () => {
  const { queue, started, end } = setup();
  queue.add(all("a", "b", "c", "d", "e", "f"));
  expect(started).toEqual(["a"]);
  await end("a");
  expect(started).toEqual(["a", "b", "c", "d", "e"]);
  await end("c");
  expect(started).toEqual(["a", "b", "c", "d", "e", "f"]);
});

it("asks for a waiting or running read once, and for an ended one again", async () => {
  const { queue, started, end } = setup();
  queue.add(all("a", "b"));
  queue.add([...all("a", "b"), { ...open("b"), list: "recentlyMerged" }]);
  await end("a");
  expect(started).toEqual(["a", "b", "b"]);
  queue.add(all("a"));
  expect(started).toEqual(["a", "b", "b", "a"]);
});

it("puts what the user is looking at ahead of everything that waits", async () => {
  const { queue, started, end } = setup();
  queue.add(all("a", "b", "c"));
  const detail = { repository: open("d").repository, number: 12 };
  queue.addFirst(detail);
  queue.addFirst(detail);
  await end("a");
  expect(started).toEqual(["a", "d", "b", "c"]);
  queue.addFirst(detail);
  expect(started, "it still runs").toEqual(["a", "d", "b", "c"]);
});

it("asks a running read once more when a write needs a fresh answer", async () => {
  const { queue, started, end } = setup();
  queue.add(all("a", "b"));
  queue.addFirst(open("a"), { again: true });
  queue.addFirst(open("a"), { again: true });
  expect(started).toEqual(["a"]);
  await end("a");
  expect(started, "once more, ahead of the rest").toEqual(["a", "a", "b"]);
  await end("a");
  expect(started).toEqual(["a", "a", "b"]);
  queue.addFirst(open("c"), { again: true });
  expect(started, "one that is not running starts").toEqual([
    "a",
    "a",
    "b",
    "c",
  ]);
});

it("asks a locked keychain once, even for a read to ask again", async () => {
  const { queue, started, end } = setup();
  queue.add(all("a"));
  queue.addFirst(open("a"), { again: true });
  await end("a", false);
  expect(started).toEqual(["a"]);
});

it("starts nothing more once it is closed", async () => {
  const { queue, started, end } = setup();
  queue.add(all("a", "b", "c", "d", "e", "f"));
  await end("a");
  queue.close();
  await end("b");
  expect(started).toEqual(["a", "b", "c", "d", "e"]);
});

it("drops the rest when the keychain stays locked, and tries alone again", async () => {
  const { queue, started, end } = setup();
  queue.add(all("a", "b", "c"));
  await end("a", false);
  expect(started).toEqual(["a"]);
  queue.add(all("a", "b", "c"));
  expect(started).toEqual(["a", "a"]);
  await end("a");
  expect(started).toEqual(["a", "a", "b", "c"]);
});
