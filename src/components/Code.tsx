import { use, useMemo } from "react";
import type { ReactNode } from "react";
import { EXTENSION_TO_FILE_FORMAT } from "@pierre/diffs";
import { File } from "@pierre/diffs/react";
import { pierreThemeOptions } from "../themes/diffTheme";
import { InTurn } from "./InTurn";
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

export function Code({
  text,
  language,
  before,
}: {
  text: string;
  language: string;
  before: ReactNode;
}) {
  const { theme, painted } = use(SurroundingsContext);
  const lang = text.length > MOST_PAINTED ? "text" : known(language);
  const file = useMemo(
    () => ({ name: "code", contents: text, lang }),
    [text, lang],
  );
  const options = useMemo(
    () => ({
      ...pierreThemeOptions(theme, painted),
      disableFileHeader: true,
      disableLineNumbers: true,
    }),
    [theme, painted],
  );
  return (
    <InTurn code={text} language={lang} before={before}>
      <File file={file} options={options} />
    </InTurn>
  );
}
