import {
  contrast,
  formatHex,
  fromOklch,
  mix,
  parseHex,
  relight,
  toOklch,
  type Rgba,
} from "./color";
import { FOREGROUND_MIX, LANE_CYCLE, RECIPES } from "./recipes.generated";

export type Appearance = "light" | "dark";

/** The colours theme.css defines for L1, which the fit script derives recipes for. */
export const STYLESHEET_TOKENS = {
  background: "--canvas",
  sidebar: "--sidebar",
  panel: "--panel",
  panelRaised: "--panel-raised",
  panelHeader: "--panel-header",
  control: "--control",
  controlInset: "--control-inset",
  controlHover: "--control-hover",
  rowHover: "--row-hover",
  rowSelected: "--row-selected",
  segmentSelected: "--segment-selected",
  border: "--border",
  borderControl: "--border-control",
  borderStrong: "--border-strong",
  separator: "--separator",
  foreground: "--text",
  textHeading: "--text-heading",
  textStrong: "--text-strong",
  textInput: "--text-input",
  textSecondary: "--text-secondary",
  textBody: "--text-body",
  textIcon: "--text-icon",
  muted: "--muted",
  textDim: "--text-dim",
  textFaint: "--text-faint",
  textHover: "--text-hover",
  blue: "--blue",
  focus: "--focus",
  selectionBg: "--selection-bg",
  selectionText: "--selection-text",
  navSelectedBg: "--nav-selected-bg",
  navSelectedText: "--nav-selected-text",
  refOnLane: "--ref-on-lane",
  onLane: "--on-lane",
  link: "--link",
  accentMuted: "--accent-muted",
  accent: "--primary-bg",
  primaryBorder: "--primary-border",
  accentForeground: "--primary-text",
  primaryHover: "--primary-hover",
  warning: "--warning",
  success: "--success",
  successMuted: "--success-muted",
  successBg: "--success-bg",
  successBgHover: "--success-bg-hover",
  deleted: "--deleted",
  errorText: "--error-text",
  errorBg: "--error-bg",
  errorBorder: "--error-border",
  warningIcon: "--warning-icon",
  warningBg: "--warning-bg",
  warningBorder: "--warning-border",
  emptyIconBg: "--empty-icon-bg",
  emptyIconEnd: "--empty-icon-end",
  emptyIconBorder: "--empty-icon-border",
  emptyIconText: "--empty-icon-text",
  scrollbar: "--scrollbar",
  shadowSubtle: "--shadow-subtle",
  shadowControl: "--shadow-control",
  shadowIcon: "--shadow-icon",
  shadowPane: "--shadow-pane",
  shadowDialog: "--shadow-dialog",
  dialogBackdrop: "--dialog-backdrop",
  graphLane1: "--graph-lane-1",
  graphLane2: "--graph-lane-2",
  graphLane3: "--graph-lane-3",
  graphLane4: "--graph-lane-4",
  graphLane5: "--graph-lane-5",
  graphLane6: "--graph-lane-6",
} as const;

/** Code colours read by the diff's CSS-variable syntax theme. L1 highlights with Pierre's themes, so theme.css has none. */
export const SYNTAX_TOKENS = {
  syntaxKeyword: "--syntax-keyword",
  syntaxFunction: "--syntax-function",
  syntaxString: "--syntax-string",
  syntaxStringExpression: "--syntax-string-expression",
  syntaxConstant: "--syntax-constant",
  syntaxParameter: "--syntax-parameter",
  syntaxPunctuation: "--syntax-punctuation",
  syntaxComment: "--syntax-comment",
} as const;

export const TOKENS = { ...STYLESHEET_TOKENS, ...SYNTAX_TOKENS };

export type StylesheetToken = keyof typeof STYLESHEET_TOKENS;
export type SyntaxToken = keyof typeof SYNTAX_TOKENS;
export type Token = StylesheetToken | SyntaxToken;

// Shadows and the backdrop are painted over other colours, so they keep their alpha; every other token is opaque.
export const TRANSLUCENT: ReadonlySet<Token> = new Set([
  "shadowSubtle",
  "shadowControl",
  "shadowIcon",
  "shadowPane",
  "shadowDialog",
  "dialogBackdrop",
]);

export type Palette = Partial<Record<Token, string>>;

export const TOKEN_NAMES = Object.keys(TOKENS).filter(isToken);

export function isToken(key: string): key is Token {
  return Object.hasOwn(TOKENS, key);
}

type Seeds = { background: Rgba; foreground: Rgba; accent: Rgba };
type Recipe = (s: Seeds, get: (token: Token) => Rgba) => Rgba;

// A fit farther than this in OKLab reads as a different colour, so the token keeps its stylesheet value.
export const MAX_FIT_DISTANCE = 0.035;

const WHITE: Rgba = { r: 1, g: 1, b: 1, a: 1 };
const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 };

export const LANES = [
  "graphLane1",
  "graphLane2",
  "graphLane3",
  "graphLane4",
  "graphLane5",
  "graphLane6",
] as const satisfies readonly Token[];

/** One of L1's lane colours: an absolute OKLCH hue and chroma, and lightness `t` between background and foreground. */
export type LaneStop = { h: number; t: number; C: number };

export const RATIO_RECIPES = {
  ink:
    (t: number): Recipe =>
    (s) =>
      mix(s.background, s.foreground, t),
  tint:
    (t: number): Recipe =>
    (s) =>
      mix(s.background, s.accent, t),
  lift:
    (t: number): Recipe =>
    (s) =>
      mix(s.accent, s.foreground, t),
  glow:
    (t: number): Recipe =>
    (s) =>
      relight(s.accent, s.foreground, t),
  shade:
    (t: number): Recipe =>
    (s) =>
      mix(s.background, BLACK, t),
  glaze:
    (alpha: number): Recipe =>
    (s) => ({ ...s.accent, a: alpha }),
} as const;

export type RecipeSpec =
  | readonly ["seed", keyof Seeds]
  | readonly [keyof typeof RATIO_RECIPES, number]
  | readonly ["fixed", string]
  | readonly ["onAccent"]
  | readonly ["hue", offset: number, t: number, chroma: number]
  | readonly ["lane", index: number]
  | readonly ["status", hue: number, t: number, chroma: number]
  | readonly ["tone", t: number, chromaScale: number]
  | readonly ["toward", token: Token, t: number]
  | readonly ["shadow", t: number, alpha: number]
  | readonly ["laneInk", minWhite: number, t: number];

export const onAccent: Recipe = (s) => {
  const dark = mix(s.accent, BLACK, 0.85);
  return contrast(WHITE, s.accent) >= 3 ? WHITE : dark;
};

// A grey accent has no hue to start lanes or turn code colours from, so it reads as L1's blue.
const GREY_ACCENT_CHROMA = 0.02;
const GREY_ACCENT_HUE = toOklch(parseHex("#346bf1") ?? BLACK).h;

function accentHue(accent: Rgba): number {
  const { C, h } = toOklch(accent);
  return C < GREY_ACCENT_CHROMA ? GREY_ACCENT_HUE : h;
}

const hueGap = (a: number, b: number) =>
  Math.abs(((((a - b) % 360) + 540) % 360) - 180);

// Colourblind confusion is about absolute hues, so lanes keep L1's hues in L1's order and only choose where to start.
function laneAt(cycle: readonly LaneStop[], index: number): Recipe {
  return (s) => {
    const gaps = cycle.map((stop) => hueGap(stop.h, accentHue(s.accent)));
    const start = gaps.indexOf(Math.min(...gaps));
    const stop = cycle[(index + start) % cycle.length];
    return stop
      ? fromOklch({ L: lightnessAt(s, stop.t), C: stop.C, h: stop.h })
      : BLACK;
  };
}

/** Lightness `t` of the way from the background's to the foreground's, so the colour keeps its contrast on any canvas. */
function lightnessAt(s: Seeds, t: number): number {
  const [bg, fg] = [toOklch(s.background).L, toOklch(s.foreground).L];
  return bg + (fg - bg) * t;
}

// `minWhite` is the contrast lane ink keeps on every lane, so ink only turns dark where white falls short of it.
const laneInk =
  (minWhite: number, t: number): Recipe =>
  (s, get) => {
    const lanes = LANES.map(get);
    const worst = (ink: Rgba) =>
      Math.min(...lanes.map((l) => contrast(ink, l)));
    const white = worst(WHITE);
    if (white >= minWhite) return WHITE;
    const darker =
      contrast(WHITE, s.background) > contrast(WHITE, s.foreground)
        ? s.background
        : s.foreground;
    const dark = mix(darker, s.accent, t);
    return worst(dark) > white ? dark : WHITE;
  };

export function recipe(spec: RecipeSpec, cycle: readonly LaneStop[]): Recipe {
  switch (spec[0]) {
    case "seed": {
      const key = spec[1];
      return (s) => s[key];
    }
    case "fixed": {
      const color = parseHex(spec[1]) ?? BLACK;
      return () => color;
    }
    case "onAccent":
      return onAccent;
    case "hue": {
      const [, offset, t, C] = spec;
      return (s) =>
        fromOklch({ L: lightnessAt(s, t), C, h: accentHue(s.accent) + offset });
    }
    case "lane":
      return laneAt(cycle, spec[1]);
    case "status": {
      const [, h, t, C] = spec;
      return (s) => fromOklch({ L: lightnessAt(s, t), C, h });
    }
    case "tone": {
      const [, t, scale] = spec;
      return (s) => {
        const { C, h } = toOklch(s.accent);
        return fromOklch({ L: lightnessAt(s, t), C: C * scale, h });
      };
    }
    case "toward": {
      const [, token, t] = spec;
      return (s, get) => mix(s.background, get(token), t);
    }
    case "shadow": {
      const [, t, alpha] = spec;
      return (s) => ({ ...mix(s.background, BLACK, t), a: alpha });
    }
    case "laneInk":
      return laneInk(spec[1], spec[2]);
    default:
      return RATIO_RECIPES[spec[0]](spec[1]);
  }
}

const FOREGROUND_TOWARD: Record<Appearance, Rgba> = {
  dark: WHITE,
  light: BLACK,
};

function mapRecord<K extends string, A, B>(
  record: Record<K, A>,
  f: (a: A, key: K) => B,
): Record<K, B> {
  const out = {} as Record<K, B>;
  for (const key in record) out[key] = f(record[key], key);
  return out;
}

// Hue offsets turn from the accent, so each theme's code colours sit around its own accent.
const SYNTAX_RECIPES: Record<Appearance, Record<SyntaxToken, RecipeSpec>> = {
  dark: {
    syntaxKeyword: ["tone", 0.8, 1],
    syntaxFunction: ["hue", 37, 0.84, 0.12],
    syntaxString: ["hue", -93, 0.82, 0.12],
    syntaxStringExpression: ["hue", -45, 0.86, 0.11],
    syntaxConstant: ["hue", -172, 0.88, 0.12],
    syntaxParameter: ["hue", 93, 0.84, 0.11],
    syntaxPunctuation: ["ink", 0.75],
    syntaxComment: ["toward", "muted", 1],
  },
  light: {
    syntaxKeyword: ["tone", 0.75, 1],
    syntaxFunction: ["hue", 37, 0.74, 0.13],
    syntaxString: ["hue", -93, 0.74, 0.12],
    syntaxStringExpression: ["hue", -45, 0.76, 0.1],
    syntaxConstant: ["hue", -172, 0.76, 0.12],
    syntaxParameter: ["hue", 93, 0.74, 0.13],
    syntaxPunctuation: ["ink", 0.8],
    syntaxComment: ["toward", "muted", 1],
  },
};

const COMPILED = mapRecord(RECIPES, (table, appearance) =>
  mapRecord({ ...table, ...SYNTAX_RECIPES[appearance] }, (spec) =>
    recipe(spec, LANE_CYCLE[appearance]),
  ),
);

/** Callers pass validated hex; an unparsable seed reads as black. */
export function derivePalette(
  appearance: Appearance,
  background: string,
  accent: string,
  foreground?: string,
): Record<Token, string> {
  return completePalette(appearance, {
    background,
    accent,
    ...(foreground ? { foreground } : {}),
  });
}

export type ThemeColors = Palette & { background: string; accent: string };

export function completePalette(
  appearance: Appearance,
  colors: ThemeColors,
): Record<Token, string> {
  const background = parseHex(colors.background) ?? BLACK;
  const foreground =
    colors.foreground ??
    formatHex(
      mix(
        background,
        FOREGROUND_TOWARD[appearance],
        FOREGROUND_MIX[appearance],
      ),
    );
  const seeds = {
    background,
    accent: parseHex(colors.accent) ?? BLACK,
    foreground: parseHex(foreground) ?? BLACK,
  };
  const recipes = COMPILED[appearance];
  // Recipes read other tokens as the hex they paint, so pinning a colour to its derived value changes nothing.
  const painted = new Map<Token, string>();
  const hex = (token: Token): string => {
    const value =
      painted.get(token) ??
      colors[token] ??
      formatHex(recipes[token](seeds, get));
    painted.set(token, value);
    return value;
  };
  const get = (token: Token) => parseHex(hex(token)) ?? BLACK;
  return mapRecord(TOKENS, (_, token) => hex(token));
}
