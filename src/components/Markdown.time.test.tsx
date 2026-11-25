// @vitest-environment happy-dom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown";

const LENGTH = 65_536;
/** What the slow ones took was several seconds, and up to minutes. */
const BUDGET_MS = 1_500;

const fill = (motif: string) => (length: number) =>
  motif.repeat(Math.ceil(length / motif.length)).slice(0, length);
const numbered = (line: (at: number) => string) => (length: number) => {
  let text = "";
  for (let at = 0; text.length < length; at += 1) text += line(at);
  return text.slice(0, length);
};
const open = (opening: string, motif: string) => (length: number) =>
  opening + fill(motif)(length - opening.length);
const table = (columns: number, rows: number) => () =>
  `${"|a".repeat(columns)}\n${"|-".repeat(columns)}\n${"|\n".repeat(rows)}`;
const within = (lines: number, length: number, motif: string, gap = "\n") =>
  `${fill(motif)(length)}${gap}`.repeat(lines);

const worst: Record<string, (length: number) => string> = {
  "a table that fills itself": table(875, 1_000),
  "a smaller table": table(300, 1_400),
  "a table of cells": table(40, 1_000),
  "a wide table": table(16_000, 2),
  "rows without cells": fill("|\n"),
  pipes: fill("|"),
  "closing brackets": fill("]"),
  "some closing brackets": (length) => fill("]")(length / 8),
  "closing brackets in many paragraphs": () => within(200, 300, "]", "\n\n"),
  "brackets with words": fill("0]"),
  "opening brackets": fill("["),
  "brackets in brackets": (length) =>
    "[".repeat(length / 2) + "]".repeat(length / 2),
  "links that don't end": fill("[a]("),
  "links in pointed brackets": fill("[a](<"),
  "links in links": (length) =>
    `${"[".repeat(length / 6)}a${"](u)".repeat(length / 6)}`,
  "images that don't end": open("![", "-a "),
  "words after a bracket": open("[", "b "),
  "a footnote that doesn't end": open("[^", "a-"),
  "footnote calls": fill("[^a]"),
  "footnotes of footnotes": numbered(
    (at) => `[^${at}]: [^${at + 1}]\n\n[^${at}]\n\n`,
  ),
  definitions: fill("[a]: b\n"),
  "definitions and references": numbered((at) => `[${at}]: x\n\n[${at}]\n\n`),
  "a long address, many times": (length) =>
    `[a]: http://a.b/${"x".repeat(length / 2)}\n\n${"[a] [a] [a]\n\n".repeat(700)}`,
  "stars and underscores": fill("*a_ "),
  "some stars and underscores": (length) => fill("*a_ ")(length / 8),
  stars: fill("*a "),
  "stars within": fill("a**b"),
  strikes: fill("~a ~~b "),
  "mixed marks": fill("*a **b _c __d ~e ~~f [g "),
  backticks: numbered((at) => `${"`".repeat(at)}a `),
  "backticks and words": (length) =>
    numbered((at) => `${"`".repeat(at)}a `)(5_000) + "b".repeat(length - 5_000),
  "comments that don't end": (length) =>
    "<!--".repeat(1_100) + "a".repeat(length - 4_400),
  "tags in a line": fill("<b>x"),
  "images in a line": fill("<img src=x>"),
  "links in a line": fill("<a href=x>y</a> "),
  "tags that don't end": fill("<a x="),
  instructions: fill("<?a "),
  entities: fill("&amp;"),
  "spaces in HTML": (length) => `<div>a${" ".repeat(length)}b</div>`,
  "lines in HTML": (length) => `<pre>${" \n".repeat(length / 2)}</pre>`,
  "spaces and words in HTML": open("<div>", `${" ".repeat(2_000)}x`),
  "elements in elements": fill("<div>"),
  "cells in cells": fill("<table><tr><td>"),
  "short lines": fill("a\n"),
  "short lines of a quote": open("> a\n", "a\n"),
  "equals signs": fill("=\n"),
  "headings with a line": fill("a\n=\n"),
  headings: fill("# a\n"),
  items: fill("- a\n"),
  tasks: fill("- [ ] a\n"),
  "carriage returns": fill("\\\r"),
  "blank quotes": fill(">\n\n\n"),
  "quotes in quotes": fill("> "),
  "lists in lists": fill("- "),
  "numbers in numbers": fill("1. "),
  "lists in lists, often": fill(`${"- ".repeat(29)}a\n`),
  "lists in lists by tabs": numbered((at) => `${"\t".repeat(at)}- a\n`),
  "lists in lists by spaces": numbered((at) => `${"  ".repeat(at % 60)}- a\n`),
  "quotes of lists": numbered((at) => `> ${"  ".repeat(at % 60)}- a\n`),
  "blank lines in a deep list": (length) =>
    `${"- ".repeat(29)}a${"\n".repeat(length)}`,
  addresses: fill("www.a.b "),
  "mail addresses": fill("a@b.c "),
  "an address with a long end": (length) =>
    `www.a.b/${'"'.repeat(length / 2)}x`,
  "an address in an address": fill("_www.a_b"),
  "at signs": fill("a@"),
  dots: fill("a.-_"),
  "blocks of code": fill("```js\na\n```\n"),
  "code within quotes": fill("> ```\n"),
  "a fence that hides nothing": (length) =>
    `<div>\n\`\`\`\n\n${"]".repeat(length)}`,
  "a fence in a comment": (length) =>
    `<!--\n\n\`\`\`\n-->\n\n${"]".repeat(length)}`,
  "a fence in an item": (length) => `- a\n\n  \`\`\`\n${"]".repeat(length)}`,
  "a fence in a fence": (length) => `~~~\n\n\`\`\`\n~~~\n${"]".repeat(length)}`,
  "a table that is none": (length) =>
    `|a|b|\n|-|\n${"|]]]]]]]]\n".repeat(length / 20)}`,
  "a table that ends": (length) => `|a|\n|-|\n> ${"]".repeat(length / 4)}`,
  "items that are none": (length) =>
    `a\n${"    - ]]]]]]]]]]]]]]]]\n".repeat(length / 60)}`,
  spaces: fill(" "),
  "spaces and words": fill(`${" ".repeat(500)}a\n`),
  "breaks of lines": fill("a  \n"),
  letters: fill("a"),
  escapes: fill("\\*"),
};

describe("Markdown nobody wrote to be read", () => {
  it.each(Object.entries(worst))("%s is soon shown or refused", (_, make) => {
    const text = make(LENGTH).slice(0, LENGTH);
    const element = createElement(Markdown, { text });
    const took = () => {
      const start = performance.now();
      try {
        renderToStaticMarkup(element);
      } catch (error) {
        expect(String(error)).toMatch(/^Error: This text /);
      }
      return performance.now() - start;
    };
    const first = took();
    expect(first < BUDGET_MS ? first : took()).toBeLessThan(BUDGET_MS);
  });
});
