// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Markdown } from "./Markdown";
import { SurroundingsContext } from "./pullRequestText";

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
    '<a href="javascript:alert(1)">a</a>',
  ])("%s opens nothing", async (text) => {
    await show(text);
    expect(links()).toEqual([]);
    expect(host.textContent).toContain("a");
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
  ["quotes in quotes", `${">".repeat(400)} deep`, "tangled"],
  ["lists in lists", `${"1. ".repeat(400)} deep`, "tangled"],
  ["emphasis without end", "*a_ ".repeat(5_000), "tangled"],
  [
    "lists in lists over many lines",
    Array.from({ length: 70 }, (_, at) => `${"  ".repeat(at)}- a`).join("\n"),
    "nested too deep",
  ],
])("refuses %s", async (_, text, why) => {
  const caught: unknown[] = [];
  await act(() => root.unmount());
  root = createRoot(host, { onUncaughtError: (error) => caught.push(error) });
  await show(text).catch((error: unknown) => caught.push(error));
  expect(String(caught[0])).toContain(why);
});
