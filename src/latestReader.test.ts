import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { latestReader } from "./latestReader";

function controlled() {
  const pending = new Map<string, (value: string) => void>();
  const reads: string[] = [];
  const delivered: string[] = [];
  const reader = latestReader<string, string>({
    read: (key) => {
      reads.push(key);
      return new Promise((resolve) => pending.set(key, resolve));
    },
    deliver: (key, outcome) =>
      delivered.push(`${key}=${outcome.ok ? outcome.value : "error"}`),
    same: (left, right) => left === right,
    stallMs: 1000,
  });
  const finish = async (key: string) => {
    pending.get(key)?.(`detail ${key}`);
    await Promise.resolve();
    await Promise.resolve();
  };
  return { reader, reads, delivered, finish };
}

describe("latest reader", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reads the newest key once the read in flight finishes", async () => {
    const { reader, reads, delivered, finish } = controlled();
    reader.want("a");
    reader.want("b");
    reader.want("c");
    expect(reads).toEqual(["a"]);
    await finish("a");
    expect(reads).toEqual(["a", "c"]);
    await finish("c");
    expect(delivered).toEqual(["c=detail c"]);
  });

  it("does not read a key twice while it is in flight", () => {
    const { reader, reads } = controlled();
    reader.want("a");
    reader.want("a");
    expect(reads).toEqual(["a"]);
  });

  it("starts the newest read when the one in flight stalls", async () => {
    const { reader, reads, delivered, finish } = controlled();
    reader.want("slow");
    reader.want("next");
    vi.advanceTimersByTime(999);
    expect(reads).toEqual(["slow"]);
    vi.advanceTimersByTime(1);
    expect(reads).toEqual(["slow", "next"]);
    await finish("next");
    await finish("slow");
    expect(delivered).toEqual(["next=detail next"]);
  });

  it("delivers nothing after the wanted key is cleared", async () => {
    const { reader, delivered, finish } = controlled();
    reader.want("a");
    reader.want(null);
    await finish("a");
    expect(delivered).toEqual([]);
  });
});
