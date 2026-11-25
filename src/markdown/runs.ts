const spaces = "\\t\\n\\f\\r \\u200b";
/** Scripts with words that are found in a dictionary. */
const dictionary =
  "\\u0e00-\\u0eff\\u1000-\\u109f\\u1780-\\u17ff\\ua980-\\ua9df";
const ideographic =
  "\\u2e80-\\u9fff\\uac00-\\ud7af\\uf900-\\ufaff\\uff00-\\uffef";
const steers = "\\u202a-\\u202e\\u2066-\\u2069";

/** Characters WebKit measures together, so that each more of them costs more. */
const joined =
  /[\p{M}\u0530-\u1cff\ua000-\uabff\ufb00-\ufdff\ufe70-\ufeff\u{10000}-\u{1efff}]/u;
const unbroken = new RegExp(
  `(?:(?![${spaces}]|(?=\\p{L})[${dictionary}${ideographic}]).){21,}`,
  "gsu",
);
const few = new RegExp(`.{20}\\p{M}{0,8}(?=.)`, "gsu");
const many = new RegExp(`.{120}\\p{M}{0,8}(?=.)`, "gsu");

/**
 * A text, cut where a line may break though no character says so. Left to find
 * such places itself, WebKit takes up to a minute for one text.
 */
export function runs(text: string): string[] {
  const ends = [...text.matchAll(unbroken)].flatMap(({ index, 0: run }) =>
    [...run.matchAll(joined.test(run) ? few : many)].map(
      ({ index: at, 0: cut }) => index + at + cut.length,
    ),
  );
  return [0, ...ends].map((from, at) => text.slice(from, ends[at]));
}

/** Where words of some letters begin, after any other words. */
const turningTo = (letter: string) =>
  new RegExp(
    `${letter}(?:[^\\p{L}\\p{N}${steers}]|${letter})*|[${steers}]`,
    "gu",
  );
const toOther = turningTo("(?=[\\p{L}\\p{M}])[^\\0-\\u024f]");
const toDictionary = turningTo(`[${dictionary}]`);

/**
 * How often a text turns to another script, or direction. A line is laid out
 * in a step for each turn, in four for some scripts, and in a square of steps
 * for directions.
 */
export const turnsIn = (text: string) =>
  (text.match(toOther)?.length ?? 0) +
  3 * (text.match(toDictionary)?.length ?? 0);

const first =
  /(?<rtl>[\u0590-\u08ff\u200f\ufb1d-\ufdff\ufe70-\ufefc\u{10800}-\u{10fff}\u{1e800}-\u{1efff}])|\p{L}/u;

/** Where a text begins, if it has any letter. */
export function directionOf(text: string): "ltr" | "rtl" | null {
  const found = first.exec(text);
  return found && (found.groups?.rtl === undefined ? "ltr" : "rtl");
}
