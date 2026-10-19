import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BUILT_IN_FAMILIES, L1_VARIANTS } from "./catalog";
import { contrast, distance, parseHex } from "./color";
import {
  derivePalette,
  MAX_FIT_DISTANCE,
  TOKENS,
  type Appearance,
} from "./palette";
import { stylesheetPalettes } from "./stylesheet";

const stylesheet = stylesheetPalettes(
  readFileSync(new URL("../theme.css", import.meta.url), "utf8"),
);

describe.each(["light", "dark"] as const)("the %s recipes", (appearance) => {
  const css = stylesheet[appearance];

  it("cover every colour theme.css defines", () => {
    expect(Object.values(TOKENS).sort()).toEqual(Object.keys(css).sort());
  });

  it("derive theme.css from its own background, accent, and text", () => {
    const derived = derivePalette(
      appearance,
      css["--canvas"] ?? "",
      css["--primary-bg"] ?? "",
      css["--text"] ?? "",
    );
    const misfits = Object.entries(TOKENS).flatMap(([token, name]) => {
      const [got, want] = [
        parseHex(derived[token as keyof typeof TOKENS]),
        parseHex(css[name] ?? ""),
      ];
      const d = got && want ? distance(got, want) : Infinity;
      return d > MAX_FIT_DISTANCE ? [`${name} ${d.toFixed(4)}`] : [];
    });
    expect(
      misfits,
      "theme.css and the recipes disagree; rerun node scripts/fit-theme-palette.mjs",
    ).toEqual([]);
  });

  it("start L1 from theme.css's background and accent", () => {
    expect(L1_VARIANTS[appearance].swatch).toEqual({
      background: css["--canvas"],
      accent: css["--primary-bg"],
    });
  });
});

const derived = BUILT_IN_FAMILIES.flatMap((f) => f.variants).filter(
  (v) => Object.keys(v.palette).length > 0,
);

const ratio = (x = "", y = "") => {
  const [p, q] = [parseHex(x), parseHex(y)];
  return p && q ? contrast(p, q) : 0;
};

it("derives a light and a dark variant for each of the five seeded families", () => {
  expect(derived.map((v) => v.id)).toEqual([
    "grove-light",
    "grove-dark",
    "ocean-light",
    "ocean-dark",
    "ember-light",
    "ember-dark",
    "iris-light",
    "iris-dark",
    "rose-light",
    "rose-dark",
  ]);
});

const L1_MUTED_CONTRAST = ratio(
  stylesheet.dark["--muted"],
  stylesheet.dark["--canvas"],
);

it.each(derived.map((v) => [v.id, v.palette] as const))(
  "keeps %s text as readable as L1 on its background and accent",
  (_, p) => {
    expect(ratio(p.foreground, p.background)).toBeGreaterThanOrEqual(7);
    expect(ratio(p.muted, p.background)).toBeGreaterThanOrEqual(
      L1_MUTED_CONTRAST,
    );
    expect(ratio(p.textDim, p.background)).toBeGreaterThanOrEqual(3);
    expect(ratio(p.accentForeground, p.accent)).toBeGreaterThanOrEqual(3);
  },
);

it("derives every token as hex, keeping the seeds verbatim", () => {
  const p = derivePalette("dark", "#0a0a0a", "#346bf1");
  expect(Object.keys(p).sort()).toEqual(Object.keys(TOKENS).sort());
  expect(
    Object.values(p).every((v) => /^#[0-9a-f]{6}([0-9a-f]{2})?$/.test(v)),
  ).toBe(true);
  expect([p.background, p.accent]).toEqual(["#0a0a0a", "#346bf1"]);
});

it.each<[Appearance, string, string]>([
  ["dark", "#0a0a0a", "#d3d3d8"],
  ["light", "#fafafa", "#303038"],
])(
  "derives a %s foreground near L1's text from L1's background",
  (appearance, background, text) => {
    const p = derivePalette(appearance, background, "#3979ce");
    const [got, want] = [parseHex(p.foreground), parseHex(text)];
    expect(got && want && distance(got, want)).toBeLessThan(0.015);
  },
);

it("puts dark text on a pale accent and white text on a deep one", () => {
  const pale = derivePalette("dark", "#2e3440", "#88c0d0").accentForeground;
  expect(pale).toBe("#030607");
  expect(ratio(pale, "#88c0d0")).toBeGreaterThanOrEqual(4.5);
  expect(derivePalette("light", "#ffffff", "#346bf1").accentForeground).toBe(
    "#ffffff",
  );
});
