import { use, useCallback, useRef } from "react";
import type { ReactNode } from "react";
import { preloadHighlighter } from "@pierre/diffs";
import type { SupportedLanguages } from "@pierre/diffs";
import { diffTheme } from "../themes/diffTheme";
import { SurroundingsContext } from "./pullRequestText";
import { useTurn } from "./useTurn";

/** Pierre takes about 25 times the memory of an element, for any code. */
const WEIGHT = 100;

/** Code is painted once it is near the view, and its language is there. */
export function InTurn({
  code,
  language,
  before,
  children,
}: {
  code: string;
  language: SupportedLanguages;
  before: ReactNode;
  children: ReactNode;
}) {
  const { theme, painted } = use(SurroundingsContext);
  const place = useRef<HTMLDivElement>(null);
  const load = useCallback(
    () =>
      preloadHighlighter({
        themes: [diffTheme(theme, painted)],
        langs: [language],
      }),
    [language, theme, painted],
  );
  const isPainted = useTurn(place, WEIGHT + code.length / 4, load);
  return <div ref={place}>{isPainted ? children : before}</div>;
}
