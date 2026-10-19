import { createCSSVariablesTheme, registerCustomTheme } from "@pierre/diffs";
import { SYNTAX_TOKENS, type Appearance, type SyntaxToken } from "./palette";

const THEME_VARIABLE: Record<SyntaxToken, string> = {
  syntaxKeyword: "token-keyword",
  syntaxFunction: "token-function",
  syntaxString: "token-string",
  syntaxStringExpression: "token-string-expression",
  syntaxConstant: "token-constant",
  syntaxParameter: "token-parameter",
  syntaxPunctuation: "token-punctuation",
  syntaxComment: "token-comment",
};

const variableDefaults: Record<string, string> = {
  foreground: "var(--text-strong)",
  "token-link": "var(--link)",
  "token-inserted": "var(--success)",
  "token-deleted": "var(--deleted)",
  "token-changed": "var(--warning)",
};
for (const [token, name] of Object.entries(THEME_VARIABLE))
  variableDefaults[name] = `var(${SYNTAX_TOKENS[token as SyntaxToken]})`;

const PALETTE_THEME: Record<Appearance, string> = {
  light: "l1-palette-light",
  dark: "l1-palette-dark",
};

// Shiki's factory always says dark; Pierre picks its light or dark mixes from the theme's type.
for (const type of ["light", "dark"] as const) {
  const name = PALETTE_THEME[type];
  const theme = createCSSVariablesTheme({
    name,
    variablePrefix: "--diffs-",
    variableDefaults,
    fontStyle: false,
  });
  registerCustomTheme(name, async () => ({ ...theme, type }));
}

/** Pierre's own theme under L1, which paints no palette; the palette's syntax colours under any other theme. */
export function diffTheme(appearance: Appearance, painted: boolean): string {
  if (painted) return PALETTE_THEME[appearance];
  return appearance === "dark" ? "pierre-dark" : "pierre-light";
}
