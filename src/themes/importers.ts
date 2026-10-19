import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { L1_VARIANTS, type ThemeDraft, type ThemeFamilyDraft } from "./catalog";
import { chroma, formatHex, isDark, over, parseHex } from "./color";
import {
  isToken,
  TRANSLUCENT,
  type Appearance,
  type Palette,
  type Token,
} from "./palette";

export type ImportResult =
  | { ok: true; family: ThemeFamilyDraft }
  | { ok: false; error: string };

const single = (draft: ThemeDraft): ImportResult => ({
  ok: true,
  family: { name: draft.name, variants: [draft] },
});

type Json = { [key: string]: unknown };

export const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export function readJsonc(text: string): Parsed<unknown> {
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true });
  const first = errors[0];
  if (!first) return { ok: true, value };
  const line = text.slice(0, first.offset).split("\n").length;
  return {
    ok: false,
    error: `Invalid JSON on line ${line}: ${printParseErrorCode(first.error)}.`,
  };
}

function tokenColor(
  token: Token,
  value: unknown,
  background: string,
): string | null {
  const color = typeof value === "string" ? parseHex(value) : null;
  if (!color) return null;
  if (color.a === 1 || TRANSLUCENT.has(token)) return formatHex(color);
  const bg = parseHex(background);
  return bg ? formatHex(over(color, bg)) : formatHex({ ...color, a: 1 });
}

function l1Theme(raw: Json): ImportResult {
  const { name, appearance, colors } = raw;
  if (raw.version !== 1)
    return { ok: false, error: "Unsupported theme version; expected 1." };
  if (typeof name !== "string" || !name.trim())
    return { ok: false, error: "The theme needs a name." };
  if (appearance !== "light" && appearance !== "dark")
    return { ok: false, error: 'appearance must be "light" or "dark".' };
  if (!isObject(colors))
    return { ok: false, error: "The theme needs a colors object." };
  const background = tokenColor("background", colors.background, "#000000");
  const accent = background && tokenColor("accent", colors.accent, background);
  if (!background || !accent)
    return {
      ok: false,
      error: "colors.background and colors.accent must be hex colours.",
    };
  const palette: Palette = {};
  for (const [key, value] of Object.entries(colors)) {
    const color = isToken(key) ? tokenColor(key, value, background) : null;
    if (isToken(key) && color) palette[key] = color;
  }
  return single({
    name: name.trim(),
    appearance,
    colors: { ...palette, background, accent },
  });
}

export type VsCodeTheme = {
  name?: string;
  type?: string;
  include?: string;
  colors: Record<string, string>;
};

export function asVsCodeTheme(raw: unknown): VsCodeTheme | null {
  if (
    !isObject(raw) ||
    !(
      isObject(raw.colors) ||
      Array.isArray(raw.tokenColors) ||
      typeof raw.include === "string"
    )
  )
    return null;
  const colors: Record<string, string> = {};
  for (const [key, value] of Object.entries(
    isObject(raw.colors) ? raw.colors : {},
  ))
    if (typeof value === "string") colors[key] = value;
  const text = (v: unknown) => (typeof v === "string" ? v : undefined);
  return {
    name: text(raw.name),
    type: text(raw.type),
    include: text(raw.include),
    colors,
  };
}

export function mergeVsCodeThemes(
  parent: VsCodeTheme,
  child: VsCodeTheme,
): VsCodeTheme {
  return {
    name: child.name ?? parent.name,
    type: child.type ?? parent.type,
    colors: { ...parent.colors, ...child.colors },
  };
}

type Source = { keys: readonly string[]; pick?: "colorful" | "neutral" };

// The first workbench colour a theme sets wins. `colorful` prefers a coloured candidate over a grey one;
// `neutral` takes greys only, so loud borders fall back to derived ones. L1 Git has no syntax tokens,
// so a theme's TextMate rules are not read.
const VS_CODE_SOURCES: Partial<Record<Token, Source>> = {
  background: { keys: ["editor.background"] },
  foreground: { keys: ["editor.foreground", "foreground"] },
  sidebar: { keys: ["sideBar.background", "activityBar.background"] },
  panel: { keys: ["panel.background"] },
  panelRaised: {
    keys: ["editorWidget.background", "dropdown.background", "menu.background"],
  },
  control: { keys: ["input.background", "dropdown.background"] },
  rowHover: { keys: ["list.hoverBackground"] },
  rowSelected: {
    keys: [
      "list.activeSelectionBackground",
      "list.inactiveSelectionBackground",
    ],
  },
  border: {
    keys: ["sideBar.border", "editorGroup.border", "panel.border"],
    pick: "neutral",
  },
  borderControl: { keys: ["input.border", "dropdown.border"], pick: "neutral" },
  accent: {
    keys: [
      "button.background",
      "focusBorder",
      "textLink.foreground",
      "activityBarBadge.background",
      "progressBar.background",
      "panelTitle.activeBorder",
      "inputOption.activeBorder",
      "tab.activeBorder",
    ],
    pick: "colorful",
  },
  focus: { keys: ["focusBorder"] },
  link: { keys: ["textLink.foreground"] },
  selectionBg: { keys: ["editor.selectionBackground", "selection.background"] },
  success: {
    keys: ["gitDecoration.addedResourceForeground", "terminal.ansiGreen"],
  },
  warning: {
    keys: ["gitDecoration.modifiedResourceForeground", "terminal.ansiYellow"],
  },
  deleted: {
    keys: [
      "gitDecoration.deletedResourceForeground",
      "errorForeground",
      "terminal.ansiRed",
    ],
  },
  errorText: { keys: ["errorForeground", "editorError.foreground"] },
  scrollbar: { keys: ["scrollbarSlider.background"] },
  graphLane1: { keys: ["terminal.ansiBlue"] },
  graphLane2: { keys: ["terminal.ansiMagenta"] },
  graphLane3: { keys: ["terminal.ansiYellow"] },
  graphLane4: { keys: ["terminal.ansiGreen"] },
  graphLane5: { keys: ["terminal.ansiBrightMagenta", "terminal.ansiRed"] },
  graphLane6: { keys: ["terminal.ansiCyan"] },
};

const isColorful = (hex: string) => chroma(hex) >= 0.1;

// A fully transparent colour is how a VS Code theme turns an element off, so it never stands in for a token.
function candidates(theme: VsCodeTheme, source: Source): string[] {
  return source.keys
    .flatMap((k) => theme.colors[k] ?? [])
    .filter((c) => (parseHex(c)?.a ?? 0) > 0);
}

const UI_THEME_APPEARANCE = new Map<string | undefined, Appearance>([
  ["vs", "light"],
  ["light", "light"],
  ["hc-light", "light"],
  ["hcLight", "light"],
  ["vs-dark", "dark"],
  ["dark", "dark"],
  ["hc-black", "dark"],
  ["hc", "dark"],
]);

/** `uiTheme` is the extension manifest's base theme, when known. */
export function vsCodeThemeToDraft(
  theme: VsCodeTheme,
  fallbackName: string,
  uiTheme?: string,
): ThemeDraft {
  const pick = (token: Token): string | undefined => {
    const source = VS_CODE_SOURCES[token];
    if (!source) return undefined;
    const found = candidates(theme, source);
    switch (source.pick) {
      case undefined:
        return found[0];
      case "colorful":
        return found.find(isColorful) ?? found[0];
      case "neutral":
        return found.find((c) => chroma(c) < 0.06);
      default: {
        const unreachable: never = source.pick;
        return unreachable;
      }
    }
  };
  const rawBackground = pick("background");
  const appearance =
    UI_THEME_APPEARANCE.get(uiTheme) ??
    UI_THEME_APPEARANCE.get(theme.type) ??
    (rawBackground && !isDark(rawBackground) ? "light" : "dark");
  const fallback = L1_VARIANTS[appearance].swatch;
  const background =
    tokenColor("background", rawBackground, "#000000") ?? fallback.background;
  const palette: Palette = {};
  for (const key of Object.keys(VS_CODE_SOURCES)) {
    const color = isToken(key) ? tokenColor(key, pick(key), background) : null;
    if (isToken(key) && color) palette[key] = color;
  }
  return {
    name: theme.name?.trim() || fallbackName,
    appearance,
    colors: {
      ...palette,
      background,
      accent: palette.accent ?? fallback.accent,
    },
  };
}

const baseName = (fileName?: string) =>
  fileName?.replace(/^.*[\\/]/, "").replace(/\.[^.]*$/, "") || "Imported theme";

export function parseThemeFile(text: string, fileName?: string): ImportResult {
  const json = readJsonc(text);
  if (!json.ok) return json;
  if (isObject(json.value) && "version" in json.value)
    return l1Theme(json.value);
  const theme = asVsCodeTheme(json.value);
  if (!theme)
    return {
      ok: false,
      error: "Not a theme: expected an L1 theme or a VS Code color theme.",
    };
  if (theme.include)
    return {
      ok: false,
      error: `This theme includes ${theme.include}, which can't be read from a single file.`,
    };
  return single(vsCodeThemeToDraft(theme, baseName(fileName)));
}
