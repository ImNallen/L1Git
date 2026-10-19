import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { z } from "zod";
import {
  addCustomThemes,
  chooseThemes,
  DEFAULT_THEME_SETTINGS,
  deleteCustomTheme,
  resolveTheme,
  type ColorScheme,
  type ThemeFamilyDraft,
  type ThemeSettings,
  type ThemeVariant,
} from "./themes/catalog";
import { isHex } from "./themes/color";
import { isToken, TOKEN_NAMES, TOKENS, type Palette } from "./themes/palette";

const storageKey = "l1git.appearance";
const systemQuery = "(prefers-color-scheme: dark)";
let nativeWrites = Promise.resolve();

const colorSchemeSchema = z.enum(["system", "light", "dark"]);

const colorsSchema = z.record(z.string(), z.unknown()).transform((colors) => {
  const palette: Palette = {};
  for (const [key, value] of Object.entries(colors))
    if (isToken(key) && typeof value === "string" && isHex(value))
      palette[key] = value.trim();
  return palette;
});

const customThemeSchema = z.object({
  id: z.string(),
  name: z.string(),
  variants: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      appearance: z.enum(["light", "dark"]),
      colors: colorsSchema,
    }),
  ),
});

const settingsSchema = z.object({
  colorScheme: colorSchemeSchema.catch(DEFAULT_THEME_SETTINGS.colorScheme),
  lightTheme: z.string().catch(DEFAULT_THEME_SETTINGS.lightTheme),
  darkTheme: z.string().catch(DEFAULT_THEME_SETTINGS.darkTheme),
  customThemes: z
    .array(z.unknown())
    .catch([])
    .transform((themes) =>
      themes.flatMap((theme) => {
        const parsed = customThemeSchema.safeParse(theme);
        return parsed.success ? [parsed.data] : [];
      }),
    ),
}) satisfies z.ZodType<ThemeSettings>;

/** Reads what `l1git.appearance` holds: these settings as JSON, or the bare scheme saved before themes existed. */
export function parseAppearanceSettings(stored: string | null): ThemeSettings {
  if (stored === null) return DEFAULT_THEME_SETTINGS;
  const legacy = colorSchemeSchema.safeParse(stored);
  if (legacy.success)
    return { ...DEFAULT_THEME_SETTINGS, colorScheme: legacy.data };
  try {
    const parsed = settingsSchema.safeParse(JSON.parse(stored));
    return parsed.success ? parsed.data : DEFAULT_THEME_SETTINGS;
  } catch {
    return DEFAULT_THEME_SETTINGS;
  }
}

function paintTheme(variant: ThemeVariant) {
  const root = document.documentElement;
  root.dataset.theme = variant.appearance;
  root.style.colorScheme = variant.appearance;
  for (const token of TOKEN_NAMES) {
    const value = variant.palette[token];
    if (value) root.style.setProperty(TOKENS[token], value);
    else root.style.removeProperty(TOKENS[token]);
  }
  root.toggleAttribute("data-palette", Object.keys(variant.palette).length > 0);
  const canvas = getComputedStyle(root).getPropertyValue("--canvas").trim();
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", canvas);
  return canvas;
}

export function initializeAppearance(): ThemeSettings {
  let settings = DEFAULT_THEME_SETTINGS;
  try {
    settings = parseAppearanceSettings(localStorage.getItem(storageKey));
  } catch {}
  paintTheme(resolveTheme(settings, window.matchMedia(systemQuery).matches));
  return settings;
}

export function useAppearance(initial: ThemeSettings) {
  const [settings, setSettings] = useState(initial);
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia(systemQuery).matches,
  );
  const [preview, setPreview] = useState<ThemeVariant | null>(null);
  const [persistenceError, setPersistenceError] = useState<string | null>(null);
  const [nativeError, setNativeError] = useState<string | null>(null);
  const saved = useMemo(
    () => resolveTheme(settings, systemDark),
    [settings, systemDark],
  );
  const variant = preview ?? saved;
  const { colorScheme } = settings;

  useEffect(() => {
    const media = window.matchMedia(systemQuery);
    const update = () => setSystemDark(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useLayoutEffect(() => {
    const canvas = paintTheme(variant);
    if (!isTauri()) return;
    let active = true;
    nativeWrites = nativeWrites
      .then(async () => {
        if (!active) return;
        const nativeWindow = getCurrentWindow();
        await nativeWindow.setTheme(
          colorScheme === "system" ? null : colorScheme,
        );
        if (active && colorScheme === "system") {
          setSystemDark(window.matchMedia(systemQuery).matches);
        }
        await nativeWindow.setBackgroundColor(canvas);
        await getCurrentWebview().setBackgroundColor(canvas);
        if (active) setNativeError(null);
      })
      .catch(() => {
        if (active)
          setNativeError("Could not update the native window appearance.");
      });
    return () => {
      active = false;
    };
  }, [colorScheme, variant]);

  function save(next: ThemeSettings) {
    setSettings(next);
    setSystemDark(window.matchMedia(systemQuery).matches);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
      setPersistenceError(null);
    } catch {
      setPersistenceError("Theme changed for this session. Could not save it.");
    }
  }

  return {
    settings,
    variant,
    setColorScheme: (next: ColorScheme) =>
      save({ ...settings, colorScheme: next }),
    chooseThemes: (variants: readonly ThemeVariant[]) =>
      save(chooseThemes(settings, variants)),
    addThemes: (drafts: readonly ThemeFamilyDraft[]) =>
      save(addCustomThemes(settings, drafts, () => crypto.randomUUID())),
    deleteTheme: (familyId: string) =>
      save(deleteCustomTheme(settings, familyId)),
    preview: setPreview,
    persistenceError,
    nativeError,
  };
}

export type AppearanceState = ReturnType<typeof useAppearance>;
