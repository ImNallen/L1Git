import { createContext, use, useMemo } from "react";
import type { ReactNode } from "react";
import { EXTENSION_TO_FILE_FORMAT } from "@pierre/diffs";
import { File } from "@pierre/diffs/react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { pierreThemeOptions } from "../themes/diffTheme";
import { SurroundingsContext } from "./pullRequestText";

type Node = {
  type: string;
  value?: string;
  url?: string;
  alt?: string | null;
  data?: { hProperties: { className: string } };
  children?: Node[];
};

const unread = "script, style, template, noscript, iframe, object";
const phrasing = new Set(["paragraph", "heading", "tableCell", "link"]);
const deepest = 60;

/** What some HTML says: its words, links, line breaks, and images. */
function said(html: string): Node[] {
  // A parsed document is inert. It runs nothing and loads nothing.
  const { body } = new DOMParser().parseFromString(html, "text/html");
  for (const each of body.querySelectorAll(unread)) each.remove();
  const of = (node: globalThis.Node): Node[] => {
    if (node instanceof Text)
      return [{ type: "text", value: node.data.replace(/\s*\n\s*/g, "\n") }];
    if (!(node instanceof Element)) return [];
    const inner = [...node.childNodes].flatMap(of);
    switch (node.localName) {
      case "br":
        return [{ type: "break" }];
      case "img":
        return [
          {
            type: "image",
            url: node.getAttribute("src") ?? "",
            alt: node.getAttribute("alt"),
          },
        ];
      case "a":
        return [
          {
            type: "link",
            url: node.getAttribute("href") ?? "",
            children: inner,
          },
        ];
      default:
        return inner;
    }
  };
  // The line breaks between elements, where they are written, at most one each.
  let broken = true;
  return [...body.childNodes].flatMap(of).filter((node) => {
    const { type, value = "" } = node;
    if (broken && type === "text") node.value = value.replace(/^\s+/, "");
    if (node.value === "") return false;
    broken = type === "break" || (type === "text" && value.endsWith("\n"));
    return true;
  });
}

/** HTML is never rendered. What it says stays, as plain text. */
function htmlAsText() {
  const walk = (parent: Node, depth: number) => {
    if (depth > deepest) throw new Error("This text is nested too deep.");
    const inline = phrasing.has(parent.type);
    parent.children = parent.children?.flatMap((node) => {
      walk(node, depth + 1);
      if (node.type !== "html") return [node];
      const words = said(node.value ?? "");
      if (inline) return words;
      const blank = words.every(({ type }) => type === "break");
      return blank
        ? []
        : [
            {
              type: "paragraph",
              data: { hProperties: { className: "markdown-html" } },
              // This paragraph keeps the line breaks in its text.
              children: words.map((word) =>
                word.type === "break" ? { type: "text", value: "\n" } : word,
              ),
            },
          ];
    });
  };
  return (tree: Node) => walk(tree, 0);
}

const opens = new Set(["https:", "http:", "mailto:"]);

function linkUrl(href: string | undefined, base: string): string | null {
  if (!href || href.startsWith("#") || !URL.canParse(href, base)) return null;
  const url = new URL(href, base);
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

const nested = /^(?:[ \t]*(?:[-+*>]|\d{1,9}[.)])){60}/m;
const mostMarks = 3_000;

/** Reading this would take the parser seconds, and nobody wrote it to be read. */
const tangled = (text: string) =>
  nested.test(text) ||
  text
    .split(/\n\s*\n/)
    .some(
      (part) => part.length - part.replace(/[*_~]/g, "").length > mostMarks,
    );

/**
 * Text from GitHub. It can't run anything, and it loads nothing. Throws on
 * text that isn't worth reading as Markdown.
 */
export function Markdown({ text }: { text: string }) {
  if (tangled(text)) throw new Error("This text is too tangled.");
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
