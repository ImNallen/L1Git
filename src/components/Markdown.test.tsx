// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileProps } from "@pierre/diffs/react";
import { Markdown } from "./Markdown";
import { SurroundingsContext } from "./pullRequestText";

const painted = vi.hoisted(() => new Map<object, unknown>());
vi.mock("@pierre/diffs/react", async (load) => {
  const pierre = await load<typeof import("@pierre/diffs/react")>();
  return {
    ...pierre,
    File: (props: FileProps<unknown, unknown>) => {
      painted.set(props.file, props.file.lang);
      return createElement(pierre.File, props);
    },
  };
});
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
});

async function show(text: string) {
  await act(() =>
    root.render(
      <SurroundingsContext
        value={{
          base: "https://github.com/octo/app/",
          theme: "dark",
          painted: false,
        }}
      >
        <Markdown text={text} />
      </SurroundingsContext>,
    ),
  );
  return host;
}
const links = () =>
  [...host.querySelectorAll("a")].map((link) => [
    link.textContent,
    link.getAttribute("href"),
  ]);

describe("links", () => {
  it.each([
    ["[a](https://a.test/x?y#z)", "https://a.test/x?y#z"],
    ["[a](http://a.test)", "http://a.test/"],
    ["[a](mailto:a@b.test)", "mailto:a@b.test"],
    ["[a](mailto:a@b.test?attach=/etc/passwd&body=x#y)", "mailto:a@b.test"],
    ["[a](//a.test/x)", "https://a.test/x"],
    ["[a](docs/x.md)", "https://github.com/octo/app/docs/x.md"],
    ["[a](/octo/other)", "https://github.com/octo/other"],
    [
      "[a](java&#10;script:alert(1))",
      "https://github.com/octo/app/java%0Ascript:alert(1)",
    ],
  ])("%s opens %s", async (text, href) => {
    await show(text);
    const link = host.querySelector("a")!;
    expect(link.getAttribute("href")).toBe(href);
    expect(link.target).toBe("_blank");
    expect(link.rel).toBe("noreferrer");
    expect(link.title).toBe(href);
  });

  it.each([
    "[a](javascript:alert(1))",
    "[a](JaVaScRiPt:alert(1))",
    "[a](\tjavascript:alert(1))",
    "[a](data:text/html,x)",
    "[a](vbscript:x)",
    "[a](file:///etc/passwd)",
    "[a](tauri://localhost/)",
    "[a](#heading)",
    "[a]()",
    "[a](https://)",
    "[a](mailto:?bcc=a@b.test)",
    '<a href="javascript:alert(1)">a</a>',
  ])("%s opens nothing", async (text) => {
    await show(text);
    expect(links()).toEqual([]);
    expect(host.textContent).toContain("a");
  });

  it.each([
    ['See <a href="https://a.test">the <b>docs</b></a> now', "the docs"],
    ['**See <a href="https://a.test">the *docs*</a>**', "the docs"],
    ['<a href="https://a.test"><img alt="shot" src="b.png"></a>', "shot"],
    ['| a |\n|---|\n| <a href="https://a.test">x</a> |', "x"],
    ['<p>See <a href="https://a.test">the docs</a></p>', "the docs"],
    ["[**bold**](https://a.test)", "bold"],
  ])("%s links its words", async (text, words) => {
    await show(text);
    expect(links()).toEqual([[words, "https://a.test/"]]);
  });

  it.each([
    'a <a href="https://a.test"></a>',
    'a <a href="https://a.test"> </a>',
    'a <a href="https://a.test">not closed',
    'a **<a href="https://a.test">x**</a>',
    'a <a href="https://a.test"><b></b><!-- x --></a>',
    "a [](https://a.test)",
    "a [ ](https://a.test) [\u200b\u2060](https://a.test)",
    "a [][r] [&nbsp;][r]\n\n[r]: https://a.test",
    'a\n\n<a href="https://a.test"></a>',
    '<a href="https://a.test">\n\na\n\n</a>',
    '<p>a<a href="https://a.test"> <i></i></a></p>',
  ])("%j has no link, as it would have no words", async (text) => {
    await show(text);
    expect(links()).toEqual([]);
    expect(host.textContent).toContain("a");
    expect(host.textContent).not.toContain("<");
  });

  it("ends a link where the next one begins", async () => {
    await show(
      '<a href="https://a.test">a <a href="https://b.test">b</a> c</a>',
    );
    expect(links()).toEqual([["b", "https://b.test/"]]);
    expect(host.textContent).toBe("a b c");
  });

  it("leaves mentions and numbers alone", async () => {
    await show("@maja fixed #12 and octo/app#3");
    expect(links()).toEqual([]);
  });

  it("never puts a link in a link", async () => {
    await show("[![badge](https://a.test/b.svg)](https://a.test/ci)");
    expect(links()).toEqual([["badge", "https://a.test/ci"]]);
  });
});

describe("images", () => {
  it("are links, and never load", async () => {
    await show(
      '![a cat](https://a.test/cat.png) ![](https://a.test/x.png)\n\n<img width="10" alt="shot" src="https://a.test/shot.png" onerror="alert(1)">',
    );
    expect(host.querySelector("img")).toBeNull();
    expect(links()).toEqual([
      ["a cat", "https://a.test/cat.png"],
      ["Image", "https://a.test/x.png"],
      ["shot", "https://a.test/shot.png"],
    ]);
  });
});

describe("HTML", () => {
  it("keeps its words and none of its elements", async () => {
    await show(
      [
        "<script>alert(1)</script>",
        "",
        "<!-- a comment -->",
        "",
        "<details open ontoggle=alert(1)>",
        "<summary>Release notes</summary>",
        "",
        "**Bold** <b onclick=alert(1)>and</b> a<br>break",
        "",
        "</details>",
        "",
        "<style>body{display:none}</style><p>One &amp; <a href='https://a.test'>two</a></p>",
        "",
        "<iframe srcdoc='alert'></iframe><form><input><svg onload=alert(1)></svg></form>",
      ].join("\n"),
    );
    expect(
      host.querySelector(
        "script, style, details, iframe, form, svg, b, input, [onclick]",
      ),
    ).toBeNull();
    expect(host.textContent).not.toContain("alert");
    expect(host.textContent).not.toContain("a comment");
    expect(host.textContent).toMatch(
      /Release notes\s*Bold and a\s*break\s*One & two/,
    );
    expect(links()).toEqual([["two", "https://a.test/"]]);
    expect(host.querySelectorAll("br")).toHaveLength(1);
  });
});

it("keeps the lines of HTML, without the gaps between its elements", async () => {
  await show(
    "<details>\n<summary>Notes</summary>\n<blockquote>\n<ul>\n<li>one</li>\n\n<li>two</li>\n</ul>\n</blockquote>\n</details>\n<br />\n\nEnd",
  );
  expect(
    [...host.querySelectorAll("p")].map(({ textContent }) =>
      textContent?.trim(),
    ),
  ).toEqual(["Notes\none", "two", "End"]);
});

it.each([
  ["<p>one</p><p>two</p>", ["one", "two"]],
  ["<ul><li>one</li><li>two</li></ul>", ["one", "two"]],
  ["<h3>one</h3>two<br>three<hr>four", ["one", "two", "three", "four"]],
  [
    "<table><tr><td>a</td><td>b</td></tr><tr><th>c</th></tr></table>",
    ["a b", "c"],
  ],
  ["<div>one <b>more</b><i>over</i></div>", ["one moreover"]],
  ["one<p>two</p>three", ["one two three"]],
  ["<div>one\n   \n two</div>", ["one", "two"]],
])("%j keeps its words apart", async (text, lines) => {
  await show(text);
  expect(
    (host.textContent ?? "")
      .split("\n")
      .map((line) => line.replace(/ +/g, " ").trim())
      .filter((line) => line !== ""),
  ).toEqual(lines);
});

it.each([
  ["**a<br>b**", "strong"],
  ["*a<br>b*", "em"],
  ["~~a<br>b~~", "del"],
  ["[a<br>b][r]\n\n[r]: https://a.test", "a"],
  ["[a<br>b](https://a.test)", "a"],
])("%s keeps its line break", async (text, element) => {
  await show(text);
  expect(host.querySelector(element)?.innerHTML).toMatch(/^a<br>\s*b$/);
});

it("puts no paragraph into a line", async () => {
  await show(
    '**<img src="https://a.test/i.png" alt="I"> end** [<img src="https://a.test/i.png" alt="I">][r]\n\n[r]: https://b.test',
  );
  expect(host.querySelectorAll("p")).toHaveLength(1);
  expect(links()).toEqual([
    ["I", "https://a.test/i.png"],
    ["I", "https://b.test/"],
  ]);
});

it("takes the direction of lists and quotes from their words", async () => {
  await show(
    "- **פריט**\n- item\n  - item\n\n3. item פריט\n\n> ציטוט\n\n- 1\n- 2",
  );
  expect(
    [...host.querySelectorAll("ul, ol, blockquote")].map((block) => [
      block.tagName,
      block.getAttribute("dir"),
    ]),
  ).toEqual([
    ["UL", "rtl"],
    ["UL", "ltr"],
    ["OL", "ltr"],
    ["BLOCKQUOTE", "rtl"],
    ["UL", null],
  ]);
});

it("starts headings at the fourth level", async () => {
  await show("# One\n## Two\n### Three\n###### Six");
  expect(
    [...host.querySelectorAll("h1, h2, h3, h4, h5, h6")].map((heading) => [
      heading.tagName,
      heading.textContent,
    ]),
  ).toEqual([
    ["H4", "One"],
    ["H5", "Two"],
    ["H6", "Three"],
    ["H6", "Six"],
  ]);
});

it("shows task lists that can't be ticked", async () => {
  await show("- [x] tests\n- [ ] docs");
  const boxes = [...host.querySelectorAll("input")];
  expect(boxes.map(({ checked, disabled }) => [checked, disabled])).toEqual([
    [true, true],
    [false, true],
  ]);
  expect(boxes[0]?.getAttribute("aria-label")).toBe("Done");
});

it("shows code through Pierre, and names a suggestion", async () => {
  await show(
    "```ts\nconst a = 1;\n```\n\n```suggestion\nlet b;\n```\n\n```nonsense-language\nc\n```\n\nand `inline`",
  );
  expect(host.querySelectorAll("diffs-container")).toHaveLength(3);
  expect(host.querySelector("figcaption")?.textContent).toBe(
    "Suggested change",
  );
  expect(host.querySelector("p code")?.textContent).toBe("inline");
});

it("paints only as much code as it can at once", async () => {
  const block = (language: string, length: number) =>
    `\`\`\`${language}\n${"a ".repeat(length / 2)}\n\`\`\`\n\n`;
  const languages = async (text: string) => {
    painted.clear();
    await show(text);
    return [...painted.values()];
  };
  expect(await languages(block("ts", 6_000).repeat(2))).toEqual([
    "typescript",
    "text",
  ]);
  const all = ["ts", "js", "css", "go", "rust", "ruby", "java"];
  expect(
    await languages(all.map((language) => block(language, 10)).join("")),
  ).toEqual(["typescript", "javascript", "css", "go", "rust", "ruby", "text"]);
});

it("shows tables, even broken ones", async () => {
  await show(
    "| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |\n\n| no | rule |\n| x |",
  );
  expect(host.querySelectorAll("table")).toHaveLength(1);
  expect(host.querySelectorAll("tbody tr")).toHaveLength(2);
  expect(host.textContent).toContain("| no | rule |");
});

it("repeats no ids from footnotes", async () => {
  await show("One[^1].\n\n[^1]: The note.");
  expect(host.textContent).toContain("The note.");
  expect(links()).toEqual([]);
  expect(host.querySelector("[id]")).toBeNull();
});

it.each([
  ["a rule", `Intro\n\n${"-".repeat(200)}\n\n**bold**`],
  ["a rule with spaces", `${"- ".repeat(80)}\n\n**bold**`],
  ["stars", `${"* ".repeat(80)}\n\n**bold**`],
  ["a quoted rule", `> ${"-".repeat(80)}\n\n**bold**`],
  ["a heading's line", `Intro\n${"=".repeat(80)}\n\n**bold**`],
  ["code with rules", `**bold**\n\n\`\`\`\n${"-".repeat(80)}\nlog\n\`\`\``],
  ["an ASCII table", `\`\`\`\n+${"-".repeat(70)}+\n| a |\n\`\`\`\n**bold**`],
  ["a wide table", `| a | b |\n|${"-".repeat(90)}|---|\n| **bold** | c |`],
  [
    "a long log",
    `**bold**\n\`\`\`\n${'[12/345] cc -O2 "a_b[0]" *x `y`\n'.repeat(600)}\`\`\``,
  ],
  [
    "a long list of links",
    `**bold**\n${"- [`a_b`](https://a.test/x): does *this*\n".repeat(400)}`,
  ],
  [
    "a long table of links",
    `**bold**\n\n| \`a\` | b |\n|---|---|\n${"| [`a_b`](https://a.test) | **1** |\n".repeat(300)}`,
  ],
  [
    "long prose in another script",
    `**bold** [字](https://a.test) ${"漢字".repeat(9_000)}`,
  ],
])("reads %s", async (_, text) => {
  await show(text);
  expect(host.querySelector("strong")?.textContent).toBe("bold");
});

const wide = (columns: number, rows: number) =>
  `${"|a".repeat(columns)}\n${"|-".repeat(columns)}\n${"|\n".repeat(rows)}`;

it.each([
  ["a table that fills itself", wide(875, 1_000), "too many parts"],
  ["a table of one row", wide(1_400, 3), "too many parts"],
  ["quotes in quotes", `${">".repeat(400)} deep`, "tangled"],
  ["lists in lists", `${"1. ".repeat(400)} deep`, "tangled"],
  ["emphasis without end", "*a_ ".repeat(5_000), "tangled"],
  [
    "lists in lists over many lines",
    Array.from({ length: 70 }, (_, at) => `${"  ".repeat(at)}- a`).join("\n"),
    "tangled",
  ],
  ["lists in lists in one line", `${"- ".repeat(30)}a`, "nested too deep"],
])("refuses %s", async (_, text, why) => {
  const caught: unknown[] = [];
  await act(() => root.unmount());
  root = createRoot(host, { onUncaughtError: (error) => caught.push(error) });
  await show(text).catch((error: unknown) => caught.push(error));
  expect(String(caught[0])).toContain(why);
});
