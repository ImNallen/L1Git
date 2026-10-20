import { describe, expect, it } from "vitest";
import { oidSchema } from "./repository";
import { uniqueShortOids } from "./shortOid";

const oid = (hex: string) => oidSchema.parse(hex.padEnd(40, "0"));

describe("short commit IDs", () => {
  it("shortens every ID to seven characters when they are unique there", () => {
    const short = uniqueShortOids([
      oid("3de65dea1"),
      oid("7729f2901"),
      oid("2c5082310"),
    ]);
    expect([...short.values()]).toEqual(["3de65de", "7729f29", "2c50823"]);
  });

  it("lengthens colliding pairs from the large fixture until each is unique", () => {
    const ids = [
      "cecd44520b427c75c017a4a37ebb0a816748e5c4",
      "d5ba02ba1f019b72092ce07e124c9ff33a7e98bf",
      "cecd4457ebc249b07937919524f41bbc35ae5477",
      "d5ba02ba10325988cca79f292dc5eb8e172ee7d2",
    ].map((hex) => oidSchema.parse(hex));
    expect([...uniqueShortOids(ids).values()]).toEqual([
      "cecd4452",
      "d5ba02ba1f",
      "cecd4457",
      "d5ba02ba10",
    ]);
  });

  it("returns nothing for no commits", () => {
    expect(uniqueShortOids([]).size).toBe(0);
  });
});
