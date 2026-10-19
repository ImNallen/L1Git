import type { Appearance } from "./palette";

const BLOCK = /:root\[data-theme="(light|dark)"\]\s*\{([^}]*)\}/g;
const DECLARATION = /(--[\w-]+)\s*:\s*([^;]+);/g;

export function stylesheetPalettes(
  css: string,
): Record<Appearance, Record<string, string>> {
  const palettes: Record<Appearance, Record<string, string>> = {
    light: {},
    dark: {},
  };
  for (const [, appearance, body] of css.matchAll(BLOCK)) {
    const palette = palettes[appearance as Appearance];
    for (const [, name, value] of (body ?? "").matchAll(DECLARATION))
      if (name && value) palette[name] = value.trim();
  }
  return palettes;
}
