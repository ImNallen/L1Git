export type Direction = "ltr" | "rtl";
export type Align = "left" | "center" | "right";
type Words = { children: Shown[] };
type Aimed = Words & { dir: Direction | null };

/** Everything Markdown can show. Nothing else of it, or of its HTML, is kept. */
export type Piece =
  | (Words & { kind: "paragraph" | "strong" | "emphasis" | "strike" | "code" })
  | (Words & { kind: "table" | "head" | "body" | "row" | "notes" | "note" })
  /** A paragraph that keeps the line breaks in its text. */
  | (Words & { kind: "lines" })
  | (Words & { kind: "heading"; level: 1 | 2 | 3 })
  | (Words & { kind: "link"; url: string })
  | (Words & { kind: "item"; task: boolean })
  | (Words & { kind: "cell"; header: boolean; align: Align | null })
  | (Aimed & { kind: "quote" | "bullets" })
  | (Aimed & { kind: "numbers"; start: number })
  | { kind: "block"; language: string; text: string }
  | { kind: "box"; checked: boolean }
  /** Where a line may break, in a run of characters without such a place. */
  | { kind: "seam" | "break" | "rule" };

export type Shown = string | Piece;

export type Tree = {
  pieces: Shown[];
  /** How many characters it holds, its addresses included. */
  size: number;
  /** About how many elements it takes to show it. */
  weight: number;
};
