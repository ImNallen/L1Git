import {
  completePalette,
  derivePalette,
  TOKEN_NAMES,
  type Appearance,
  type Palette,
  type ThemeColors,
} from "./palette";

export type ThemeId = string;
export type ColorScheme = "system" | "light" | "dark";

export type ThemeVariant = {
  id: ThemeId;
  name: string;
  appearance: Appearance;
  swatch: { background: string; accent: string };
  palette: Palette;
};

export type ThemeFamily = {
  id: string;
  name: string;
  /** Light variants first, then dark, each in source order. */
  variants: readonly ThemeVariant[];
  custom: boolean;
};

export type ThemeDraft = {
  name: string;
  appearance: Appearance;
  colors: ThemeColors;
};

export type ThemeFamilyDraft = {
  name: string;
  variants: readonly ThemeDraft[];
};

export type CustomThemeVariant = {
  id: ThemeId;
  name: string;
  appearance: Appearance;
  colors: Palette;
};

export type CustomTheme = {
  id: string;
  name: string;
  variants: readonly CustomThemeVariant[];
};

export type ThemeSettings = {
  colorScheme: ColorScheme;
  lightTheme: ThemeId;
  darkTheme: ThemeId;
  customThemes: readonly CustomTheme[];
};

export const APPEARANCES = [
  "light",
  "dark",
] as const satisfies readonly Appearance[];

export const APPEARANCE_LABEL: Record<Appearance, string> = {
  light: "Light",
  dark: "Dark",
};

// theme.css is L1's palette, so painting L1 sets no inline vars.
export const L1_VARIANTS: Record<Appearance, ThemeVariant> = {
  light: {
    id: "l1-light",
    name: "L1 Light",
    appearance: "light",
    swatch: { background: "#fafafa", accent: "#316fc1" },
    palette: {},
  },
  dark: {
    id: "l1-dark",
    name: "L1 Dark",
    appearance: "dark",
    swatch: { background: "#0a0a0a", accent: "#3979ce" },
    palette: {},
  },
};

export const DEFAULT_THEME_SETTINGS: ThemeSettings = {
  colorScheme: "system",
  lightTheme: L1_VARIANTS.light.id,
  darkTheme: L1_VARIANTS.dark.id,
  customThemes: [],
};

const L1: ThemeFamily = {
  id: "l1",
  name: "L1",
  custom: false,
  variants: [L1_VARIANTS.light, L1_VARIANTS.dark],
};

type Seed = { background: string; accent: string };

function derivedFamily(
  id: string,
  name: string,
  seeds: Record<Appearance, Seed>,
): ThemeFamily {
  const variant = (appearance: Appearance): ThemeVariant => ({
    id: `${id}-${appearance}`,
    name: `${name} ${APPEARANCE_LABEL[appearance]}`,
    appearance,
    swatch: seeds[appearance],
    palette: derivePalette(
      appearance,
      seeds[appearance].background,
      seeds[appearance].accent,
    ),
  });
  return {
    id,
    name,
    custom: false,
    variants: [variant("light"), variant("dark")],
  };
}

export const BUILT_IN_FAMILIES: readonly ThemeFamily[] = [
  L1,
  derivedFamily("grove", "Grove", {
    light: { background: "#fafcf8", accent: "#23845a" },
    dark: { background: "#0c1310", accent: "#2f9e6e" },
  }),
  derivedFamily("ocean", "Ocean", {
    light: { background: "#f6f9fc", accent: "#1477b0" },
    dark: { background: "#0a1219", accent: "#2b8fc7" },
  }),
  derivedFamily("ember", "Ember", {
    light: { background: "#fdf9f6", accent: "#c75a1a" },
    dark: { background: "#14100d", accent: "#e0702a" },
  }),
  derivedFamily("iris", "Iris", {
    light: { background: "#f9f8fe", accent: "#6a48f0" },
    dark: { background: "#0f0e17", accent: "#7c5cff" },
  }),
  derivedFamily("rose", "Rose", {
    light: { background: "#fdf7f9", accent: "#cc2f66" },
    dark: { background: "#150d11", accent: "#e0457b" },
  }),
];

export function customVariant(theme: CustomThemeVariant): ThemeVariant {
  const fallback = L1_VARIANTS[theme.appearance].swatch;
  const swatch = {
    background: theme.colors.background ?? fallback.background,
    accent: theme.colors.accent ?? fallback.accent,
  };
  return {
    id: theme.id,
    name: theme.name,
    appearance: theme.appearance,
    swatch,
    palette: completePalette(theme.appearance, { ...theme.colors, ...swatch }),
  };
}

/** A draft that reproduces `variant`, keeping only the colours its seeds don't already derive. */
export function draftOf(variant: ThemeVariant, name: string): ThemeDraft {
  const { appearance, swatch, palette } = variant;
  let colors: Palette = { ...palette };
  // A colour equal to what the rest derive can go: every colour it feeds then derives the same.
  for (const token of TOKEN_NAMES) {
    const value = colors[token];
    if (!value || token === "background" || token === "accent") continue;
    const rest = { ...colors };
    delete rest[token];
    if (completePalette(appearance, { ...rest, ...swatch })[token] === value)
      colors = rest;
  }
  return { name, appearance, colors: { ...colors, ...swatch } };
}

export function customFamily(theme: CustomTheme): ThemeFamily | null {
  const parsed = theme.variants.map(customVariant);
  const variants = APPEARANCES.flatMap((a) =>
    parsed.filter((v) => v.appearance === a),
  );
  return variants.length > 0
    ? { id: theme.id, name: theme.name, custom: true, variants }
    : null;
}

export function themeFamilies(
  customThemes: readonly CustomTheme[],
): ThemeFamily[] {
  return [
    ...BUILT_IN_FAMILIES,
    ...customThemes.flatMap((theme) => customFamily(theme) ?? []),
  ];
}

export function familyPicks(family: ThemeFamily): ThemeVariant[] {
  return APPEARANCES.flatMap(
    (a) => family.variants.find((v) => v.appearance === a) ?? [],
  );
}

export const FIXED_APPEARANCE: Record<ColorScheme, Appearance | null> = {
  system: null,
  light: "light",
  dark: "dark",
};

export function schemeAppearance(
  scheme: ColorScheme,
  systemPrefersDark: boolean,
): Appearance {
  return FIXED_APPEARANCE[scheme] ?? (systemPrefersDark ? "dark" : "light");
}

export const THEME_SLOT = {
  light: "lightTheme",
  dark: "darkTheme",
} as const satisfies Record<Appearance, keyof ThemeSettings>;

/** The variant saved for `appearance`, or L1's when the saved id is gone or belongs to the other appearance. */
export function pickedVariant(
  settings: ThemeSettings,
  appearance: Appearance,
): ThemeVariant {
  const id = settings[THEME_SLOT[appearance]];
  const variants = themeFamilies(settings.customThemes).flatMap(
    (f) => f.variants,
  );
  return (
    variants.find((v) => v.id === id && v.appearance === appearance) ??
    L1_VARIANTS[appearance]
  );
}

export function resolveTheme(
  settings: ThemeSettings,
  systemPrefersDark: boolean,
): ThemeVariant {
  return pickedVariant(
    settings,
    schemeAppearance(settings.colorScheme, systemPrefersDark),
  );
}

/** Puts each variant in its appearance's slot, and switches a pinned scheme when it would hide every pick. */
export function chooseThemes(
  settings: ThemeSettings,
  variants: readonly ThemeVariant[],
): ThemeSettings {
  const next = { ...settings };
  for (const v of variants) next[THEME_SLOT[v.appearance]] = v.id;
  const pinned = FIXED_APPEARANCE[settings.colorScheme];
  const first = variants[0];
  if (first && pinned && !variants.some((v) => v.appearance === pinned))
    next.colorScheme = first.appearance;
  return next;
}

/** Saves each family as one theme and picks the first light and first dark of the first one. */
export function addCustomThemes(
  settings: ThemeSettings,
  drafts: readonly ThemeFamilyDraft[],
  newId: () => string,
): ThemeSettings {
  const added = drafts.map((draft): CustomTheme => {
    const id = `custom-${newId()}`;
    const variants = draft.variants.map((v, i) => ({
      id: `${id}-${i}`,
      name: v.name,
      appearance: v.appearance,
      colors: { ...v.colors },
    }));
    return { id, name: draft.name, variants };
  });
  const first = added[0] && customFamily(added[0]);
  return chooseThemes(
    { ...settings, customThemes: [...settings.customThemes, ...added] },
    first ? familyPicks(first) : [],
  );
}

/** Sends any appearance that used one of the theme's variants back to L1. */
export function deleteCustomTheme(
  settings: ThemeSettings,
  familyId: string,
): ThemeSettings {
  const gone = new Set(
    settings.customThemes
      .find((t) => t.id === familyId)
      ?.variants.map((v) => v.id),
  );
  const next = {
    ...settings,
    customThemes: settings.customThemes.filter((t) => t.id !== familyId),
  };
  for (const a of APPEARANCES)
    if (gone.has(next[THEME_SLOT[a]])) next[THEME_SLOT[a]] = L1_VARIANTS[a].id;
  return next;
}
