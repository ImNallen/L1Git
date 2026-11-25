import { describe, expect, it } from "vitest";
import { readMarkdown } from "./readMarkdown";
import type { Shown } from "./tree";

const read = (text: string) =>
  readMarkdown(text, "https://github.com/octo/app/");

function every(pieces: readonly Shown[]): Shown[] {
  return pieces.flatMap((piece) =>
    typeof piece !== "string" && "children" in piece
      ? [piece, ...every(piece.children)]
      : [piece],
  );
}
const all = (text: string) => every(read(text).pieces);
const urls = (text: string) =>
  all(text).flatMap((piece) =>
    typeof piece !== "string" && piece.kind === "link" ? [piece.url] : [],
  );

it("makes a tree that can be sent, of nothing but what is shown", () => {
  const text =
    'Hi **there** <b onclick=x>you</b>\n\n- [x] [a](b "t")\n\n```js\nx\n```';
  expect(read(text)).toEqual({
    pieces: [
      {
        kind: "paragraph",
        children: ["Hi ", { kind: "strong", children: ["there"] }, " ", "you"],
      },
      {
        kind: "bullets",
        dir: "ltr",
        children: [
          {
            kind: "item",
            task: true,
            children: [
              { kind: "box", checked: true },
              " ",
              {
                kind: "link",
                url: "https://github.com/octo/app/b",
                children: ["a"],
              },
            ],
          },
        ],
      },
      { kind: "block", language: "js", text: "x" },
    ],
    size: 44,
    weight: 22 + 44 / 20,
  });
  expect(structuredClone(read(text))).toEqual(read(text));
});

const wide = (columns: number, rows: number) =>
  `${"|a".repeat(columns)}\n${"|-".repeat(columns)}\n${"|\n".repeat(rows)}`;
const bidi = (length: number) => "אa".repeat(length / 2);

describe("a text that holds too much", () => {
  it.each([
    ["a table that fills itself", wide(875, 1_000), "too many parts"],
    ["paragraphs", "a\n\n".repeat(2_001), "too many parts"],
    [
      "an address that is repeated",
      `[a]: http://x/${"y".repeat(2_000)}\n\n${"[a] ".repeat(120)}`,
      "too long",
    ],
    ["a line that turns", bidi(4_100), "turns too often"],
    ["lines that turn", `${bidi(100)}\n\n`.repeat(41), "turns too often"],
    ["code that turns", `\`\`\`\n${bidi(4_100)}\n\`\`\``, "turns too often"],
    ["steered words", "a\u2066".repeat(2_001), "turns too often"],
    ["words in two scripts", "aか".repeat(2_001), "turns too often"],
    ["and in one with a dictionary", "aไ".repeat(501), "turns too often"],
    [
      "characters of every kind",
      Array.from({ length: 2_001 }, (_, at) =>
        String.fromCodePoint(0x4e00 + at),
      ).join(""),
      "too many kinds",
    ],
  ])("is refused: %s", (_, text, why) => {
    expect(() => read(text)).toThrow(why);
  });

  it.each([
    ["a long table", wide(3, 400)],
    ["Hebrew", "זהו טקסט בעברית, עם סימנים. ".repeat(2_300)],
    [
      "Hebrew with other words",
      "זהו טקסט בעברית של API או `code`. ".repeat(900),
    ],
    ["a word without end", "a".repeat(65_000)],
    ["Thai", "ภาษาไทย และ API ".repeat(480)],
    ["Chinese", "使用 React 的钩子，以及类型。".repeat(1_900)],
  ])("is not: %s", (_, text) => {
    expect(read(text).pieces).not.toHaveLength(0);
  });
});

it("says about how many elements it takes to show a text", () => {
  expect(read("a").weight).toBe(2 + 1 / 20);
  expect(read("אa").weight).toBe(3 + 2 / 20);
});

it("fills up no table that is too large", () => {
  const started = performance.now();
  expect(() => read(wide(2_500, 2_500))).toThrow("too many parts");
  expect(performance.now() - started).toBeLessThan(2_000);
});

it("never repeats an address that is too long to open", () => {
  const address = `http://x/${"y".repeat(2_048)}`;
  const text = `[a]: ${address}\n\n[a] [b](${address}) ![c](${address}) <${address}> <a href="${address}">d</a>`;
  expect(urls(text)).toEqual([]);
  expect(read(text).size).toBeLessThan(2 * address.length);
  expect(urls(`[a](<http://x/${"漢".repeat(300)}>)`)).toEqual([]);
  expect(urls(`[a](http://x/${"y".repeat(2_000)})`)).toHaveLength(1);
});

describe("a run of characters without a place to break", () => {
  const cuts = (text: string) =>
    all(text).filter(
      (piece) => typeof piece !== "string" && piece.kind === "seam",
    ).length;
  it.each([
    ["letters", "a".repeat(500), 4],
    ["an address", `http://a.test/${"b/".repeat(150)}`, 2],
    ["two directions", "אa".repeat(250), 24],
    ["spaces that keep words together", "a ".repeat(250), 4],
    ["pairs of code units", "𝒳".repeat(250), 12],
    ["letters with marks", "a\u0301".repeat(250), 24],
    ["marks of a script that needs no spaces", "a\u0e38".repeat(250), 24],
    ["words", "lorem ipsum ".repeat(50), 0],
    ["an ideographic script", "漢字".repeat(250), 0],
    ["a script that needs no spaces", "ภาษาไทย".repeat(70), 0],
  ])("is cut: %s", (_, text, seams) => {
    expect(cuts(text)).toBe(seams);
    expect(
      all(text)
        .filter((piece) => typeof piece === "string")
        .join(""),
    ).toBe(text.replace(/ +$/, ""));
  });

  it("is cut before no mark that belongs to a letter", () => {
    expect(all(`${"a".repeat(19)}e\u0301bc`).slice(1)).toEqual([
      `${"a".repeat(19)}e\u0301`,
      { kind: "seam" },
      "bc",
    ]);
  });
});
