import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { latestReader } from "./latestReader";

function controlled() {
  const pending: {
    key: string;
    resolve: (value: string) => void;
    reject: (error: Error) => void;
  }[] = [];
  const delivered: string[] = [];
  const reader = latestReader<string, string>({
    read: (key) =>
      new Promise((resolve, reject) => pending.push({ key, resolve, reject })),
    deliver: (key, outcome) =>
      delivered.push(`${key}=${outcome.ok ? outcome.value : "error"}`),
    same: (left, right) => left === right,
    stallMs: 1000,
    maxReads: 2,
  });
  const flush = async () => {
    for (let tick = 0; tick < 4; tick++) await Promise.resolve();
  };
  const finish = async (index: number) => {
    const read = pending[index];
    read?.resolve(`detail ${read.key}`);
    await flush();
  };
  const fail = async (index: number) => {
    pending[index]?.reject(new Error("read failed"));
    await flush();
  };
  const reads = () => pending.map((read) => read.key);
  return { reader, reads, delivered, finish, fail };
}

describe("latest reader", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reads the newest key once the read in flight finishes", async () => {
    const { reader, reads, delivered, finish } = controlled();
    reader.want("a");
    reader.want("b");
    reader.want("c");
    expect(reads()).toEqual(["a"]);
    await finish(0);
    expect(reads()).toEqual(["a", "c"]);
    await finish(1);
    expect(delivered).toEqual(["c=detail c"]);
  });

  it("reads a settled key once, however long it stays wanted", async () => {
    const { reader, reads, delivered, finish } = controlled();
    reader.want("a");
    await finish(0);
    vi.advanceTimersByTime(10_000);
    await finish(1);
    expect(reads()).toEqual(["a"]);
    expect(delivered).toEqual(["a=detail a"]);
  });

  it("reads a settled key again when it is wanted again", async () => {
    const { reader, reads, finish } = controlled();
    reader.want("a");
    await finish(0);
    reader.want("a");
    expect(reads()).toEqual(["a", "a"]);
  });

  it("does not read a key twice while it is in flight", () => {
    const { reader, reads } = controlled();
    reader.want("a");
    reader.want("a");
    expect(reads()).toEqual(["a"]);
  });

  it("starts the newest read when the one in flight stalls", async () => {
    const { reader, reads, delivered, finish } = controlled();
    reader.want("slow");
    reader.want("next");
    vi.advanceTimersByTime(999);
    expect(reads()).toEqual(["slow"]);
    vi.advanceTimersByTime(1);
    expect(reads()).toEqual(["slow", "next"]);
    await finish(1);
    await finish(0);
    expect(delivered).toEqual(["next=detail next"]);
  });

  it("keeps at most two reads in flight when every read hangs", async () => {
    const { reader, reads, finish } = controlled();
    for (const key of ["a", "b", "c", "d", "e"]) {
      reader.want(key);
      vi.advanceTimersByTime(1000);
    }
    vi.advanceTimersByTime(30_000);
    expect(reads()).toEqual(["a", "b"]);
    await finish(0);
    expect(reads()).toEqual(["a", "b", "e"]);
  });

  it("ignores a stalled read of a key that a newer read of it replaced", async () => {
    const { reader, reads, delivered, finish, fail } = controlled();
    reader.want("a");
    vi.advanceTimersByTime(1000);
    reader.want("b");
    reader.want("a");
    await finish(1);
    expect(reads()).toEqual(["a", "b", "a"]);
    await fail(0);
    await finish(2);
    expect(delivered).toEqual(["a=detail a"]);
  });

  it("delivers nothing after the wanted key is cleared", async () => {
    const { reader, delivered, finish } = controlled();
    reader.want("a");
    reader.want(null);
    await finish(0);
    expect(delivered).toEqual([]);
  });
});
