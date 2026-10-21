import { describe, expect, it } from "vitest";
import { oneReadPerKey } from "./oneReadPerKey";

function reads() {
  const started: string[] = [];
  const finish = new Map<string, (() => void)[]>();
  const request = oneReadPerKey((key: string) => {
    started.push(key);
    return new Promise<void>((resolve, reject) =>
      finish.set(key, [
        ...(finish.get(key) ?? []),
        key === "bad" ? reject : resolve,
      ]),
    );
  });
  const settle = async (key: string) => {
    finish.get(key)?.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
  };
  return { started, request, settle };
}

describe("one read per key", () => {
  it("runs one read per key and folds requests during it into one more read", async () => {
    const { started, request, settle } = reads();
    request("a");
    request("b");
    request("a");
    request("a");
    expect(started).toEqual(["a", "b"]);
    await settle("a");
    expect(started).toEqual(["a", "b", "a"]);
    await settle("a");
    expect(started).toEqual(["a", "b", "a"]);
    request("a");
    expect(started).toEqual(["a", "b", "a", "a"]);
  });

  it("frees the key after a failed read", async () => {
    const { started, request, settle } = reads();
    request("bad");
    await settle("bad");
    request("bad");
    expect(started).toEqual(["bad", "bad"]);
  });
});
