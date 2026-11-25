import { fromHtml } from "hast-util-from-html";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { directionOf, runs, turnsIn } from "./runs";
import type { Align, Direction, Piece, Shown, Tree } from "./tree";

/** Beyond these, showing a text would take long, however fast it was read. */
const most = {
  pieces: 4_000,
  characters: 200_000,
  url: 2_048,
  /** Looking for the fonts of 20,000 takes a second in WebKit. */
  kinds: 2_000,
  turns: 2_000,
};

type Node = {
  type: string;
  align?: unknown[] | null;
  value?: string;
  url?: string;
  alt?: string | null;
  data?: { hProperties: { className?: string; dir?: Direction } };
  children?: Node[];
};

/** What both parsers make of HTML. */
type Html = {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: Html[];
};

const text = (value: string): Node => ({ type: "text", value });

const unread = new Set([
  "script",
  "style",
  "template",
  "noscript",
  "iframe",
  "object",
]);
const block =
  /^(?:address|article|aside|blockquote|caption|center|d[dlt]|details|dialog|div|fieldset|fig(?:caption|ure)|footer|form|h[1-6r]|header|legend|li|main|menu|nav|[ou]l|option|p|pre|section|summary|table|t(?:body|foot|head|r))$/;
const cell = /^t[dh]$/;

/** What a page of this HTML holds. Parsing runs nothing and loads nothing. */
function parsed(html: string): Html[] {
  const { children }: Html = fromHtml(html);
  const page = children?.find(({ tagName }) => tagName === "html");
  return (
    page?.children?.find(({ tagName }) => tagName === "body")?.children ?? []
  );
}

const attribute = ({ properties }: Html, name: string) =>
  properties?.[name] == null ? null : String(properties[name]);
const imageOf = (element: Html): Node => ({
  type: "image",
  url: attribute(element, "src") ?? "",
  alt: attribute(element, "alt"),
});
const linkOf = (element: Html, children: Node[]): Node => ({
  type: "link",
  url: attribute(element, "href") ?? "",
  children,
});

/** At most one line break in a row, and no spaces around it. */
const tidy = (value: string) =>
  value
    .split("\n")
    .map((line, at, { length }) => {
      const start = at === 0 ? line : line.trimStart();
      return at === length - 1 ? start : start.trimEnd();
    })
    .filter((line, at, { length }) => line !== "" || at % (length - 1) === 0)
    .join("\n");

function saidBy(node: Html): Node[] {
  const { type, tagName = "", value = "", children = [] } = node;
  if (type === "text") return [text(tidy(value))];
  if (unread.has(tagName)) return [];
  const inner = children.flatMap(saidBy);
  if (tagName === "br") return [text("\n")];
  if (tagName === "img") return [imageOf(node)];
  if (tagName === "a") return [linkOf(node, inner)];
  if (cell.test(tagName)) return [...inner, text(" ")];
  return block.test(tagName) ? [text("\n"), ...inner, text("\n")] : inner;
}

/** What a block of HTML says: its words, links, lines, and images. */
function said(html: string): Node[] {
  let broken = true;
  return parsed(html)
    .flatMap(saidBy)
    .filter((node) => {
      if (node.type !== "text") {
        broken = false;
        return true;
      }
      const { value = "" } = node;
      node.value = broken ? value.trimStart() : value;
      if (node.value === "") return false;
      broken = value.endsWith("\n");
      return true;
    });
}

const tag = /^<(\/?)([a-z][a-z0-9-]*)/i;
const elementOf = (html: string) =>
  parsed(html).find(({ type }) => type === "element") ?? null;

/** Among the pieces of a line, each tag is one, and its words are others. */
function withoutTags(nodes: readonly Node[]): Node[] {
  const shown: Node[] = [];
  /** The link that is open, and where its words begin. */
  let link: { element: Html; from: number } | null = null;
  for (const node of nodes) {
    const [, closes, named] =
      node.type === "html" ? (tag.exec(node.value ?? "") ?? []) : [];
    const name = named?.toLowerCase();
    if (node.type !== "html") shown.push(node);
    else if (name === "a") {
      if (closes && link)
        shown.push(linkOf(link.element, shown.splice(link.from)));
      const element = closes ? null : elementOf(node.value ?? "");
      link = element ? { element, from: shown.length } : null;
    } else if (name === "br") shown.push({ type: "break" });
    else if (name === "img") {
      const element = elementOf(node.value ?? "");
      if (element) shown.push(imageOf(element));
    } else if (name && (block.test(name) || cell.test(name)))
      shown.push(text(" "));
  }
  return shown;
}

const visible = /[^\s\p{C}\p{Default_Ignorable_Code_Point}]/u;
const links = new Set(["link", "linkReference"]);
const drawn = new Set(["image", "imageReference", "footnoteReference"]);
const shows = ({ type, value = "", children = [] }: Node): boolean =>
  drawn.has(type) ||
  (type !== "html" && visible.test(value)) ||
  children.some(shows);

/** A link without words would be a place to land on, and nothing to see. */
const wordless = (node: Node) => links.has(node.type) && !shows(node);

/**
 * Where a block's own words begin. A `dir` of `auto` says the same, but WebKit
 * looks through the whole block for each element in it.
 */
function direction({
  type,
  value = "",
  children = [],
}: Node): Direction | null {
  if (type === "text") return directionOf(value);
  for (const child of children) {
    const found = direction(child);
    if (found !== null) return found;
  }
  return null;
}

const flow = new Set(["root", "blockquote", "listItem", "footnoteDefinition"]);

function paragraph(words: Node[]): Node[] {
  const children = words.flatMap((node) =>
    wordless(node) ? (node.children ?? []) : [node],
  );
  return children.some(shows)
    ? [
        {
          type: "paragraph",
          data: { hProperties: { className: "lines" } },
          children,
        },
      ]
    : [];
}

/** About how long an address is once it is encoded. */
const lengthOf = (url: string) =>
  url.replace(/[^\x21-\x7e]/g, "%00%00%00").length;

/** GitHub breaks a line wherever the person who wrote it did. */
const withBreaks = (node: Node): Node[] =>
  node.type === "text"
    ? (node.value ?? "")
        .split(/\r\n?|\n/)
        .flatMap((line, at) =>
          at === 0 ? [text(line)] : [{ type: "break" }, text(line.trimStart())],
        )
    : [node];

/** HTML is never rendered. What it says stays, as plain text. */
function htmlAsText() {
  const walk = (parent: Node) => {
    // Each reference repeats the address, so a long one is cut before that.
    if (parent.url && lengthOf(parent.url) > most.url) parent.url = "";
    if (!parent.children) return;
    // Each row is filled up to the first, which took 1 GB in the time there is.
    if ((parent.align?.length ?? 0) * parent.children.length > most.pieces)
      throw new Error("This text has too many parts.");
    for (const node of parent.children) walk(node);
    parent.children = parent.children.flatMap(withBreaks);
    parent.children = flow.has(parent.type)
      ? parent.children.flatMap((node) =>
          node.type === "html" ? paragraph(said(node.value ?? "")) : [node],
        )
      : withoutTags(parent.children).flatMap((node) =>
          wordless(node) ? (node.children ?? []) : [node],
        );
    if (parent.type !== "list" && parent.type !== "blockquote") return;
    const dir = direction(parent);
    if (dir !== null) parent.data = { hProperties: { dir } };
  };
  return walk;
}

const opens = new Set(["https:", "http:"]);

function linkUrl(href: string, base: string): string | null {
  if (!href || href.startsWith("#") || !URL.canParse(href, base)) return null;
  const url = new URL(href, base);
  // A mail link could fill in a whole mail. It only says whom to write to.
  if (url.protocol === "mailto:")
    return url.pathname.includes("@") ? `mailto:${url.pathname}` : null;
  return opens.has(url.protocol) && url.href.length <= most.url
    ? url.href
    : null;
}

const parser = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(htmlAsText)
  .use(remarkRehype)
  .freeze();

/** Spaces and line breaks in these say nothing. */
const holds = new Set(["ul", "ol", "table", "thead", "tbody", "tr", "section"]);
const around = {
  strong: "strong",
  em: "emphasis",
  del: "strike",
  code: "code",
  table: "table",
  thead: "head",
  tbody: "body",
  tr: "row",
  section: "notes",
  sup: "note",
} as const;
const levels = { h1: 1, h2: 2, h3: 3, h4: 3, h5: 3, h6: 3 } as const;
const has = <Keys extends object>(
  keys: Keys,
  key: string,
): key is string & keyof Keys => Object.hasOwn(keys, key);

const wordsIn = ({ value = "", children = [] }: Html): string =>
  value + children.map(wordsIn).join("");

/** Throws on a text that holds too much to show. */
export function readMarkdown(markdown: string, base: string): Tree {
  let pieces = 0;
  let size = 0;
  let turns = 0;
  const kinds = new Set<string>();
  let linked = false;

  /** Each piece is made by this, so what is too much is never made. */
  function make<Made extends Shown>(made: Made, holding: string): Made {
    // Code takes about as many elements, and is watched for coming into view.
    pieces += typeof made !== "string" && made.kind === "block" ? 10 : 1;
    size += holding.length;
    turns += turnsIn(holding);
    for (const kind of holding.match(/[^\0-\u024f]/gu) ?? []) kinds.add(kind);
    if (pieces > most.pieces) throw new Error("This text has too many parts.");
    if (size > most.characters) throw new Error("This text is too long.");
    if (kinds.size > most.kinds)
      throw new Error("This text has too many kinds.");
    if (turns > most.turns) throw new Error("This text turns too often.");
    return made;
  }
  const write = (value: string) =>
    runs(value).flatMap((run, at): Shown[] =>
      at === 0
        ? [make(run, run)]
        : [make({ kind: "seam" }, ""), make(run, run)],
    );
  function link(href: string, children: () => Shown[]): Shown[] {
    const url = linked ? null : linkUrl(href, base);
    if (url === null) return children();
    linked = true;
    const made = make({ kind: "link", url, children: children() }, url);
    linked = false;
    return [made];
  }

  function shown(node: Html): Shown[] {
    const { type, tagName = "", properties = {}, value = "" } = node;
    if (type === "text") return write(value);
    const children = () =>
      (node.children ?? [])
        .filter((child) => child.type !== "text" || !holds.has(tagName))
        .flatMap(shown);
    const dir = (properties.dir ?? null) as Direction | null;
    const piece = (): Piece | null => {
      if (has(around, tagName))
        return { kind: around[tagName], children: children() };
      if (has(levels, tagName))
        return {
          kind: "heading",
          level: levels[tagName],
          children: children(),
        };
      switch (tagName) {
        case "p":
          return {
            kind: properties.className === undefined ? "paragraph" : "lines",
            children: children(),
          };
        case "blockquote":
          return { kind: "quote", dir, children: children() };
        case "ul":
          return { kind: "bullets", dir, children: children() };
        case "ol":
          return {
            kind: "numbers",
            dir,
            start: Number(properties.start ?? 1),
            children: children(),
          };
        case "li":
          return {
            kind: "item",
            task: String(properties.className).includes("task-list-item"),
            children: children(),
          };
        case "th":
        case "td":
          return {
            kind: "cell",
            header: tagName === "th",
            align: (properties.align ?? null) as Align | null,
            children: children(),
          };
        case "input":
          return { kind: "box", checked: properties.checked === true };
        case "br":
          return { kind: "break" };
        case "hr":
          return { kind: "rule" };
        default:
          return null;
      }
    };
    if (tagName === "a") return link(attribute(node, "href") ?? "", children);
    if (tagName === "img")
      return link(attribute(node, "src") ?? "", () =>
        write(attribute(node, "alt")?.trim() || "Image"),
      );
    if (tagName === "pre") {
      const code = node.children?.[0] ?? node;
      const text = wordsIn(code).replace(/\n$/, "");
      const [name = ""] = (code.properties?.className ?? []) as string[];
      const language = name.replace(/^language-/, "").toLowerCase();
      // An empty suggestion is one to delete the lines.
      return text.trim() === "" && language !== "suggestion"
        ? []
        : [make({ kind: "block", language, text }, text)];
    }
    const made = piece();
    return made === null ? children() : [make(made, "")];
  }

  const root: Html = parser.runSync(parser.parse(markdown));
  const blocks = root.children?.filter(({ type }) => type === "element") ?? [];
  return {
    pieces: blocks.flatMap(shown),
    size,
    weight: pieces + turns + size / 20,
  };
}
