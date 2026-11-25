/**
 * Whether the parser would need long for some Markdown. It is quadratic in
 * several ways, so a text of one page can take minutes. Everything here is far
 * above what people and bots write. Each limit bounds one of those ways:
 * lines of a paragraph, blocks in blocks, what breaks a text into pieces, and
 * how far the parser looks around from a bracket, a star, or a backtick.
 */
const most = {
  lines: 1_500,
  depth: 30,
  nested: 3_000,
  breaks: 3_000,
  looking: 8_000_000,
};

const count = (text: string, what: RegExp) => text.match(what)?.length ?? 0;

const container = /[ \t]*(>|(?:[-+*]|\d{1,9}[.)])(?=[ \t]|$))/y;

/**
 * How many quotes and list items each line is in, at most. A list item is open
 * until a line that can't be in it. A rule (`- - -`) opens none.
 */
function depths(lines: readonly string[]): number[] {
  /** Where the content of each open item begins. */
  const items: number[] = [];
  let blank = true;
  return lines.map((line) => {
    const close = (column: number) => {
      while ((items.at(-1) ?? -1) > column) items.pop();
    };
    const spaced = line.replace(/\t/g, "    ");
    const says = spaced.search(/[^ >]/);
    if (blank && says >= 0) close(says);
    blank = says < 0;
    const ruled = spaced.trimEnd().at(-1) ?? "";
    let rule = spaced.length;
    let marks = 0;
    if (ruled === "-" || ruled === "*")
      for (; rule > 0 && `${ruled} `.includes(spaced[rule - 1] ?? ""); rule--)
        if (spaced[rule - 1] === ruled) marks += 1;
    let quotes = 0;
    container.lastIndex = 0;
    for (;;) {
      const [, mark] = container.exec(spaced) ?? [];
      const end = container.lastIndex;
      if (mark === undefined || (marks >= 3 && end > rule)) break;
      if (mark === ">") quotes += 1;
      else {
        close(end - mark.length);
        items.push(end + 1);
      }
    }
    return quotes + items.length;
  });
}

const after = (what: string) => new RegExp(`^[\\s>*+.)\\d-]*(?:${what})`, "i");
const likeFence = after("```|~~~");
const html = after("<");
const htmlOverBlanks = after("<(?:[!?]|pre|script|style|textarea)");
const fence = /^(?:`{3,}(?=[^`]*$)|~{3,})/;
const item = /^ {0,3}(?:[-+*][ \t]+\S|#{1,6}[ \t])/;
const row = /^ {0,3}\|/;
const delimiters = /^ {0,3}\|(?:[ \t]*:?-+:?[ \t]*\|)+[ \t]*$/;
const cells = (line: string) =>
  line.includes("\\") || !line.trimEnd().endsWith("|")
    ? -1
    : line.split("|").length;

/**
 * How far the parser looks, at most, in characters and pieces. It looks within
 * one text: a paragraph, an item, or a row. What may not be an end of one here
 * counts as none. Code that can't be anything else is not looked into.
 */
function looking(lines: readonly string[]): number {
  let sum = 0;
  let marks = 0;
  let length = 0;
  let pieces = 0;
  let labelled = false;
  const end = () => {
    sum += marks * length + (labelled ? pieces ** 2 / 3 : 0);
    marks = length = pieces = 0;
    labelled = false;
  };

  let code: RegExp | null = null;
  let codeIsSure = true;
  let tagged = false;
  let first = true;
  let table = false;
  lines.forEach((line, at) => {
    if (code !== null) {
      if (code.test(line)) code = null;
      return;
    }
    if (line.trim() === "") {
      end();
      table = tagged = false;
      first = true;
      return;
    }
    tagged ||= html.test(line);
    const [opens] = fence.exec(line) ?? [];
    if (opens !== undefined && codeIsSure && !tagged) {
      end();
      table = first = false;
      code = new RegExp(`^ {0,3}${opens[0]}{${opens.length},}[ \\t]*$`);
      return;
    }
    if (likeFence.test(line) || htmlOverBlanks.test(line)) codeIsSure = false;
    const next = lines[at + 1] ?? "";
    if (first && row.test(line) && delimiters.test(next))
      table = cells(line) === cells(next);
    else table &&= row.test(line);
    first = false;
    if (table || item.test(line)) end();
    marks += count(line, /[[\]*_~`]|<(?=[!?])/g);
    length += line.length + 1;
    pieces += count(line, /[a-z0-9]+|[!-/:-@[-`{-~]/gi) + 1;
    labelled ||= line.includes("[");
    // What may be the end of a link is looked through once for each character.
    for (const [tail] of line.matchAll(/(?:[!"')*,.:;?_~\]]|&[a-z]+){20,}/gi))
      sum += 2 * tail.length ** 2;
  });
  end();
  return sum;
}

export function isLaborious(markdown: string): boolean {
  if (count(markdown, /[\\&<|@]|www\.|:\/\//gi) > most.breaks) return true;
  const lines = markdown.split(/\r\n?|\n/);
  if (lines.length > most.lines) return true;
  let nested = 0;
  for (const depth of depths(lines)) {
    nested += depth;
    if (depth > most.depth || nested > most.nested) return true;
  }
  return looking(lines) > most.looking;
}
