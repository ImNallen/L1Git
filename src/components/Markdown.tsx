import { createElement, Fragment, Suspense } from "react";
import type { ReactNode } from "react";
import type { Shown, Tree } from "../markdown/tree";
import { Code } from "../shell/lazyViews";

function Block({ text, language }: { text: string; language: string }) {
  const before = <pre className="code-plain">{text}</pre>;
  return (
    <Suspense fallback={before}>
      <Code text={text} language={language} before={before} />
    </Suspense>
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
      return around("p", { className: "markdown-lines" });
    case "typed":
      return around("span", { className: "markdown-lines" });
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
      return (
        <figure className="pull-code markdown-code">
          {piece.language === "suggestion" && (
            <figcaption>
              {piece.text === ""
                ? "Suggested change: delete these lines"
                : piece.text.trim() === ""
                  ? "Suggested change: blank lines"
                  : "Suggested change"}
            </figcaption>
          )}
          {piece.text !== "" && (
            <Block text={piece.text} language={piece.language} />
          )}
        </figure>
      );
    default: {
      const exhaustive: never = piece;
      return exhaustive;
    }
  }
}

/** Text from GitHub, as it was read. It can't run anything, and it loads nothing. */
export function Markdown({
  tree,
  isWhole = true,
}: {
  tree: Tree;
  /** Not while there is more of the text. */
  isWhole?: boolean;
}) {
  if (tree.pieces.length === 0) return isWhole ? <p>No visible text.</p> : null;
  return createElement(Fragment, null, ...tree.pieces.map(shown));
}
