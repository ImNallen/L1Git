import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = new URL("../", import.meta.url);
const styles = new URL("./", import.meta.url);

describe("stylesheets", () => {
  it("are each imported by the app, so none ships without loading", () => {
    const importers = readdirSync(src, { recursive: true, encoding: "utf8" })
      .filter((name) => /\.(tsx?|css)$/.test(name))
      .filter((name) => !name.startsWith("styles/"))
      .map((name) => readFileSync(new URL(name, src), "utf8"))
      .join("\n");
    const unused = readdirSync(styles)
      .filter((name) => name.endsWith(".css"))
      .filter((name) => !importers.includes(`styles/${name}`));
    expect(unused).toEqual([]);
  });
});
