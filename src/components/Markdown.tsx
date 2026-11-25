import { createContext, use, useMemo } from "react";
import type { ReactNode } from "react";
import { EXTENSION_TO_FILE_FORMAT } from "@pierre/diffs";
import { File } from "@pierre/diffs/react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { isLaborious } from "../domain/markdownWork";
import { pierreThemeOptions } from "../themes/diffTheme";
import { SurroundingsContext } from "./pullRequestText";

type Node = {
  type: string;
  value?: string;
  url?: string;
  alt?: string | null;
  lang?: string | null;
  align?: unknown[] | null;
  data?: { hProperties: { className: string } };
  children?: Node[];
};

const text = (value: string): Node => ({ type: "text", value });

const unread = "script, style, template, noscript, iframe, object";
const block =
  /^(?:address|article|aside|blockquote|caption|center|d[dlt]|details|dialog|div|fieldset|fig(?:caption|ure)|footer|form|h[1-6r]|header|legend|li|main|menu|nav|[ou]l|option|p|pre|section|summary|table|t(?:body|foot|head|r))$/;
const cell = /^t[dh]$/;
const deepest = 60;
const mostParts = 6_000;
const mostPainted = { characters: 10_000, languages: 6 };

/** About how much it takes to show a node without those in it. */
function parts({ type, align, children }: Node): number {
  // A row is filled up to the columns of its table.
  if (type === "table") return (align?.length ?? 0) * (children?.length ?? 0);
  return type === "code" ? 40 : 1;
}

/** Parsed HTML is inert. It runs nothing and loads nothing. */
function parsed(html: string) {
  const { body } = new DOMParser().parseFromString(html, "text/html");
  for (const each of body.querySelectorAll(unread)) each.remove();
  return body;
}

const imageOf = (element: Element): Node => ({
  type: "image",
  url: element.getAttribute("src") ?? "",
  alt: element.getAttribute("alt"),
});
const linkOf = (element: Element, children: Node[]): Node => ({
  type: "link",
  url: element.getAttribute("href") ?? "",
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

function saidBy(node: globalThis.Node): Node[] {
  if (node instanceof Text) return [text(tidy(node.data))];
  if (!(node instanceof Element)) return [];
  const inner = [...node.childNodes].flatMap(saidBy);
  const { localName } = node;
  if (localName === "br") return [text("\n")];
  if (localName === "img") return [imageOf(node)];
  if (localName === "a") return [linkOf(node, inner)];
  if (cell.test(localName)) return [...inner, text(" ")];
  return block.test(localName) ? [text("\n"), ...inner, text("\n")] : inner;
}

/** What a block of HTML says: its words, links, lines, and images. */
function said(html: string): Node[] {
  let broken = true;
  return saidBy(parsed(html)).filter((node) => {
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

/** Among the pieces of a line, each tag is one, and its words are others. */
function withoutTags(nodes: readonly Node[]): Node[] {
  const shown: Node[] = [];
  /** The link that is open, and where its words begin. */
  let link: { element: Element; from: number } | null = null;
  for (const node of nodes) {
    const [, closes, named] =
      node.type === "html" ? (tag.exec(node.value ?? "") ?? []) : [];
    const name = named?.toLowerCase();
    if (node.type !== "html") shown.push(node);
    else if (name === "a") {
      if (closes && link)
        shown.push(linkOf(link.element, shown.splice(link.from)));
      const element = closes ? null : parsed(node.value ?? "").children[0];
      link = element ? { element, from: shown.length } : null;
    } else if (name === "br") shown.push({ type: "break" });
    else if (name === "img") {
      const element = parsed(node.value ?? "").children[0];
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

const flow = new Set(["root", "blockquote", "listItem", "footnoteDefinition"]);

function paragraph(words: Node[]): Node[] {
  const children = words.flatMap((node) =>
    wordless(node) ? (node.children ?? []) : [node],
  );
  return children.some(shows)
    ? [
        {
          type: "paragraph",
          // This paragraph keeps the line breaks in its text.
          data: { hProperties: { className: "markdown-html" } },
          children,
        },
      ]
    : [];
}

/** HTML is never rendered. What it says stays, as plain text. */
function htmlAsText() {
  return (tree: Node) => {
    let shown = 0;
    let characters = 0;
    const languages = new Set<string>();
    const paint = (code: Node) => {
      if (!code.lang || code.lang === "suggestion") return;
      characters += code.value?.length ?? 0;
      languages.add(code.lang);
      if (
        characters > mostPainted.characters ||
        languages.size > mostPainted.languages
      )
        code.lang = "text";
    };
    const walk = (parent: Node, depth: number) => {
      if (depth > deepest) throw new Error("This text is nested too deep.");
      shown += parts(parent);
      if (shown > mostParts) throw new Error("This text has too many parts.");
      if (parent.type === "code") paint(parent);
      if (!parent.children) return;
      for (const node of parent.children) walk(node, depth + 1);
      parent.children = flow.has(parent.type)
        ? parent.children.flatMap((node) =>
            node.type === "html" ? paragraph(said(node.value ?? "")) : [node],
          )
        : withoutTags(parent.children).flatMap((node) =>
            wordless(node) ? (node.children ?? []) : [node],
          );
    };
    walk(tree, 0);
  };
}

const opens = new Set(["https:", "http:"]);

function linkUrl(href: string | undefined, base: string): string | null {
  if (!href || href.startsWith("#") || !URL.canParse(href, base)) return null;
  const url = new URL(href, base);
  // A mail link could fill in a whole mail. It only says whom to write to.
  if (url.protocol === "mailto:")
    return url.pathname.includes("@") ? `mailto:${url.pathname}` : null;
  return opens.has(url.protocol) ? url.href : null;
}

const InLink = createContext(false);

function Link({
  href,
  children,
}: {
  href: string | undefined;
  children?: ReactNode;
}) {
  const url = linkUrl(href, use(SurroundingsContext).base);
  const nested = use(InLink);
  if (url === null || nested) return <span>{children}</span>;
  return (
    <InLink value>
      <a href={url} title={url} target="_blank" rel="noreferrer">
        {children}
      </a>
    </InLink>
  );
}

const languages = new Set<unknown>(Object.values(EXTENSION_TO_FILE_FORMAT));
const known = (language: string) =>
  languages.has(language)
    ? language
    : Object.hasOwn(EXTENSION_TO_FILE_FORMAT, language)
      ? (EXTENSION_TO_FILE_FORMAT[language] ?? "text")
      : "text";

function Code({ text, language }: { text: string; language: string }) {
  const { theme, painted } = use(SurroundingsContext);
  const file = useMemo(
    () => ({ name: "code", contents: text, lang: known(language) }),
    [text, language],
  );
  const options = useMemo(
    () => ({
      ...pierreThemeOptions(theme, painted),
      disableFileHeader: true,
      disableLineNumbers: true,
    }),
    [theme, painted],
  );
  if (text.trim() === "") return null;
  return (
    <figure className="pull-code markdown-code">
      {language === "suggestion" && <figcaption>Suggested change</figcaption>}
      <File file={file} options={options} />
    </figure>
  );
}

/** A heading here sits below the screen's own. */
const components: Components = {
  h1: ({ children }) => <h4 className="markdown-h1">{children}</h4>,
  h2: ({ children }) => <h5 className="markdown-h2">{children}</h5>,
  h3: ({ children }) => <h6>{children}</h6>,
  h4: ({ children }) => <h6>{children}</h6>,
  h5: ({ children }) => <h6>{children}</h6>,
  h6: ({ children }) => <h6>{children}</h6>,
  a: ({ href, children }) => <Link href={href}>{children}</Link>,
  img: ({ src, alt }) => (
    <Link href={typeof src === "string" ? src : undefined}>
      {alt?.trim() ? alt : "Image"}
    </Link>
  ),
  li: ({ className, children }) => <li className={className}>{children}</li>,
  input: ({ checked }) => (
    <input
      type="checkbox"
      checked={checked === true}
      disabled
      aria-label={checked === true ? "Done" : "To do"}
    />
  ),
  table: ({ children }) => (
    <div
      className="markdown-table"
      role="group"
      aria-label="Table"
      tabIndex={0}
    >
      <table>{children}</table>
    </div>
  ),
  pre: ({ node }) => {
    const code = node?.children[0];
    if (code?.type !== "element") return null;
    const names = code.properties.className;
    const name = Array.isArray(names) ? String(names[0] ?? "") : "";
    return (
      <Code
        text={code.children
          .map((child) => (child.type === "text" ? child.value : ""))
          .join("")
          .replace(/\n$/, "")}
        language={name.replace(/^language-/, "").toLowerCase()}
      />
    );
  },
};

const plugins = [remarkGfm, htmlAsText];

/**
 * Text from GitHub. It can't run anything, and it loads nothing. Throws on
 * text that isn't worth reading as Markdown.
 */
export function Markdown({ text }: { text: string }) {
  if (isLaborious(text)) throw new Error("This text is too tangled.");
  return (
    <ReactMarkdown
      skipHtml
      remarkPlugins={plugins}
      urlTransform={(url) => url}
      components={components}
    >
      {text}
    </ReactMarkdown>
  );
}
