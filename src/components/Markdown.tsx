import { createElement, Fragment, use, useMemo } from "react";
import type { ReactNode } from "react";
import { EXTENSION_TO_FILE_FORMAT } from "@pierre/diffs";
import { File } from "@pierre/diffs/react";
import type { Shown, Tree } from "../markdown/tree";
import { pierreThemeOptions } from "../themes/diffTheme";
import { SurroundingsContext } from "./pullRequestText";

const languages = new Set<unknown>(Object.values(EXTENSION_TO_FILE_FORMAT));
const known = (language: string) =>
  languages.has(language)
    ? language
    : Object.hasOwn(EXTENSION_TO_FILE_FORMAT, language)
      ? (EXTENSION_TO_FILE_FORMAT[language] ?? "text")
      : "text";

/** Painting this much takes 120 ms of a frame in WebKit, for some languages. */
const MOST_PAINTED = 10_000;

function Code({ text, language }: { text: string; language: string }) {
  const { theme, painted } = use(SurroundingsContext);
  const file = useMemo(
    () => ({
      name: "code",
      contents: text,
      lang: text.length > MOST_PAINTED ? "text" : known(language),
    }),
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
  const deletes = text.trim() === "";
  return (
    <figure className="pull-code markdown-code">
      {language === "suggestion" && (
        <figcaption>
          {deletes
            ? "Suggested change: delete these lines"
            : "Suggested change"}
        </figcaption>
      )}
      {!deletes && <File file={file} options={options} />}
    </figure>
  );
}

/** A heading here sits below the screen's own. */
const headings = { 1: "h4", 2: "h5", 3: "h6" } as const;

function shown(piece: Shown): ReactNode {
  if (typeof piece === "string") return piece;
  const around = (tag: string, props: object = {}) =>
    createElement(
      tag,
      props,
      ...("children" in piece ? piece.children.map(shown) : []),
    );
  switch (piece.kind) {
    case "paragraph":
      return around("p");
    case "lines":
      return around("p", { className: "markdown-html" });
    case "strong":
      return around("strong");
    case "emphasis":
      return around("em");
    case "strike":
      return around("del");
    case "code":
      return around("code");
    case "note":
      return around("sup");
    case "notes":
      return around("section");
    case "head":
      return around("thead");
    case "body":
      return around("tbody");
    case "row":
      return around("tr");
    case "seam":
      return around("wbr");
    case "break":
      return around("br");
    case "rule":
      return around("hr");
    case "heading":
      return around(headings[piece.level], {
        className: `markdown-h${piece.level}`,
      });
    case "quote":
      return around("blockquote", { dir: piece.dir });
    case "bullets":
      return around("ul", { dir: piece.dir });
    case "numbers":
      return around("ol", { dir: piece.dir, start: piece.start });
    case "item":
      return around("li", piece.task ? { className: "task-list-item" } : {});
    case "cell":
      return around(
        piece.header ? "th" : "td",
        piece.align ? { style: { textAlign: piece.align } } : {},
      );
    case "link":
      return around("a", {
        href: piece.url,
        title: piece.url,
        target: "_blank",
        rel: "noreferrer",
      });
    case "box":
      return (
        <input
          type="checkbox"
          checked={piece.checked}
          disabled
          aria-label={piece.checked ? "Done" : "To do"}
        />
      );
    case "table":
      return (
        <div
          className="markdown-table"
          role="group"
          aria-label="Table"
          tabIndex={0}
        >
          {around("table")}
        </div>
      );
    case "block":
      return <Code text={piece.text} language={piece.language} />;
    default: {
      const exhaustive: never = piece;
      return exhaustive;
    }
  }
}

/** Text from GitHub, as it was read. It can't run anything, and it loads nothing. */
export function Markdown({ tree }: { tree: Tree }) {
  if (tree.pieces.length === 0) return <p>No visible text.</p>;
  return createElement(Fragment, null, ...tree.pieces.map(shown));
}
