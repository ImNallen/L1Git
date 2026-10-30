import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BUILT_IN_FAMILIES, L1_VARIANTS } from "./catalog";
import { contrast, distance, parseHex, toOklch } from "./color";
import {
  completePalette,
  derivePalette,
  LANES,
  MAX_FIT_DISTANCE,
  STYLESHEET_TOKENS,
  SYNTAX_TOKENS,
  TOKENS,
  type Appearance,
  type SyntaxToken,
} from "./palette";
import { stylesheetPalettes } from "./stylesheet";

const stylesheet = stylesheetPalettes(
  readFileSync(new URL("../theme.css", import.meta.url), "utf8"),
);

describe.each(["light", "dark"] as const)("the %s recipes", (appearance) => {
  const css = stylesheet[appearance];

  it("cover every colour theme.css defines", () => {
    expect(Object.values(STYLESHEET_TOKENS).sort()).toEqual(
      Object.keys(css).sort(),
    );
  });

  it("derive theme.css from its own background, accent, and text", () => {
    const derived = derivePalette(
      appearance,
      css["--canvas"] ?? "",
      css["--primary-bg"] ?? "",
      css["--text"] ?? "",
    );
    const misfits = Object.entries(STYLESHEET_TOKENS).flatMap(
      ([token, name]) => {
        const [got, want] = [
          parseHex(derived[token as keyof typeof TOKENS]),
          parseHex(css[name] ?? ""),
        ];
        const d = got && want ? distance(got, want) : Infinity;
        return d > MAX_FIT_DISTANCE ? [`${name} ${d.toFixed(4)}`] : [];
      },
    );
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

const WCAG_AA_TEXT_CONTRAST = 4.5;

it.each(derived.map((v) => [v.id, v.palette] as const))(
  "keeps %s muted, dim, and faint text at AA 4.5:1, and the rest as readable as L1",
  (_, p) => {
    expect(ratio(p.foreground, p.background)).toBeGreaterThanOrEqual(7);
    for (const token of ["muted", "textDim", "textFaint"] as const)
      for (const surface of [p.background, p.sidebar])
        expect(ratio(p[token], surface)).toBeGreaterThanOrEqual(
          WCAG_AA_TEXT_CONTRAST,
        );
    expect(ratio(p.borderInput, p.controlInset)).toBeGreaterThanOrEqual(3);
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
  ["dark", "#0a0a0a", "#f5f5f5"],
  ["light", "#fcfcfc", "#27272a"],
])(
  "derives a %s foreground near L1's text from L1's background",
  (appearance, background, text) => {
    const p = derivePalette(appearance, background, "#346bf1");
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

const variantPalette = (id: string) =>
  derived.find((v) => v.id === id)?.palette ?? {};

const builtInLanes = BUILT_IN_FAMILIES.flatMap((f) => f.variants).map(
  (v) =>
    [
      v.id,
      v.appearance,
      LANES.map(
        (lane) =>
          v.palette[lane] ?? stylesheet[v.appearance][STYLESHEET_TOKENS[lane]],
      ),
    ] as const,
);

it("starts each theme's lanes from L1's lane nearest its accent and keeps L1's order", () => {
  expect(LANES.map((lane) => variantPalette("grove-dark")[lane])).toEqual([
    "#32d6c1",
    "#fdc128",
    "#ff7488",
    "#c387ff",
    "#a5e837",
    "#4e83f9",
  ]);
  expect(
    Object.fromEntries(builtInLanes.map(([id, , lanes]) => [id, lanes[0]])),
  ).toEqual({
    "l1-light": "#1b4ed8",
    "l1-dark": "#4a7ef4",
    "grove-light": "#0d756d",
    "grove-dark": "#32d6c1",
    "ocean-light": "#1a4cd6",
    "ocean-dark": "#4e83f9",
    "ember-light": "#b35207",
    "ember-dark": "#ff7488",
    "iris-light": "#9231e8",
    "iris-dark": "#c286ff",
    "rose-light": "#df1946",
    "rose-dark": "#fe7488",
  });
});

const hue = (hex = "") => {
  const color = parseHex(hex);
  return color ? toOklch(color).h : NaN;
};
const hueGap = (a: number, b: number) =>
  Math.abs(((((a - b) % 360) + 540) % 360) - 180);

// Colourblind confusion depends on absolute hue, so only L1's own neighbours are known to stay apart.
it.each(builtInLanes)(
  "keeps %s lanes in L1's hues and order, so neighbouring lanes stay apart for colourblind eyes",
  (_, appearance, lanes) => {
    const l1 = LANES.map((lane) =>
      hue(stylesheet[appearance][STYLESHEET_TOKENS[lane]]),
    );
    const rotations = l1.flatMap((_, k) =>
      lanes.every((lane, i) => hueGap(hue(lane), l1[(i + k) % 6] ?? NaN) <= 2)
        ? [k]
        : [],
    );
    expect(rotations).toHaveLength(1);
  },
);

it.each(derived.map((v) => [v.id, v.palette] as const))(
  "keeps %s lanes at 3:1 on the canvas, with initials and ref names at 4.5:1 on each lane",
  (_, p) => {
    for (const lane of LANES) {
      expect(ratio(p[lane], p.background)).toBeGreaterThanOrEqual(3);
      expect(ratio(p.onLane, p[lane])).toBeGreaterThanOrEqual(4.5);
      expect(ratio(p.refOnLane, p[lane])).toBeGreaterThanOrEqual(4.5);
    }
  },
);

it("puts dark initials on a dark theme's lanes and keeps white on a light theme's", () => {
  expect(variantPalette("grove-dark").onLane).toBe("#101c16");
  expect(variantPalette("grove-light").onLane).toBe("#ffffff");
});

it("puts dark ink on pale lanes a theme brings, and keeps white on deep ones", () => {
  const pale = Object.fromEntries(LANES.map((lane) => [lane, "#f1fa8c"]));
  const light = completePalette("light", {
    background: "#ffffff",
    accent: "#346bf1",
    ...pale,
  });
  expect([light.onLane, light.refOnLane]).toEqual(["#282828", "#282828"]);
  const deep = Object.fromEntries(LANES.map((lane) => [lane, "#1d4ed8"]));
  const dark = completePalette("dark", {
    background: "#0a0a0a",
    accent: "#346bf1",
    ...deep,
  });
  expect([dark.onLane, dark.refOnLane]).toEqual(["#ffffff", "#ffffff"]);
});

const STATUS = [
  "success",
  "successMuted",
  "deleted",
  "errorText",
  "warning",
  "warningIcon",
] as const;

it.each(derived.map((v) => [v.id, v.palette] as const))(
  "keeps %s status colours at 3:1 on the canvas and selected text readable",
  (_, p) => {
    for (const status of STATUS)
      expect(ratio(p[status], p.background)).toBeGreaterThanOrEqual(3);
    expect(ratio(p.selectionText, p.selectionBg)).toBeGreaterThanOrEqual(4.5);
  },
);

it("tints status washes and shadows with the theme's background", () => {
  const grove = variantPalette("grove-dark");
  expect([grove.success, grove.successBg, grove.shadowPane]).toEqual([
    "#38d69b",
    "#173126",
    "#01010177",
  ]);
  const ember = variantPalette("ember-light");
  expect([ember.errorBg, ember.accentMuted, ember.shadowPane]).toEqual([
    "#fbeae5",
    "#895b46",
    "#19181826",
  ]);
});

it("washes the background toward the status colour a theme brings", () => {
  const p = completePalette("dark", {
    background: "#282a36",
    accent: "#bd93f9",
    success: "#50fa7b",
  });
  expect([p.success, p.successBg, p.successBgHover]).toEqual([
    "#50fa7b",
    "#344c45",
    "#3a5f4c",
  ]);
});

it("tints error washes toward the red a theme brings", () => {
  const p = completePalette("dark", {
    background: "#282a36",
    accent: "#bd93f9",
    deleted: "#ff5555",
  });
  expect(p.errorBorder).toBe("#5c3940");
});

it("starts lanes from L1's blue when the accent is grey", () => {
  for (const accent of ["#808080", "#7f8081"]) {
    const p = derivePalette("dark", "#0a0a0a", accent);
    expect([p.graphLane1, p.graphLane3]).toEqual(["#4a7ef4", "#fbbf24"]);
  }
});

it.each(derived.map((v) => [v.id, v.palette] as const))(
  "keeps %s code readable on the diff, comments at 3:1 and the rest at 4.5:1",
  (_, p) => {
    for (const surface of [p.background, p.panelRaised])
      for (const token of Object.keys(SYNTAX_TOKENS) as SyntaxToken[])
        expect(ratio(p[token], surface)).toBeGreaterThanOrEqual(
          token === "syntaxComment" ? 3 : 4.5,
        );
  },
);

it("colours keywords with the accent and turns the rest of the code with it", () => {
  const grove = variantPalette("grove-dark");
  const ember = variantPalette("ember-light");
  expect([
    grove.syntaxKeyword,
    grove.syntaxString,
    grove.syntaxComment,
  ]).toEqual(["#72daa7", "#fbb76d", "#939795"]);
  expect([
    ember.syntaxKeyword,
    ember.syntaxString,
    ember.syntaxComment,
  ]).toEqual(["#8c3800", "#6e4087", "#686665"]);
});
