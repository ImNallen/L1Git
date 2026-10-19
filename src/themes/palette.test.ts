import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BUILT_IN_FAMILIES, L1_VARIANTS } from "./catalog";
import { contrast, distance, parseHex } from "./color";
import {
  completePalette,
  derivePalette,
  LANES,
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

const variantPalette = (id: string) =>
  derived.find((v) => v.id === id)?.palette ?? {};

it("turns the graph lanes with the accent, so each family's first lane is its accent hue", () => {
  expect(LANES.map((lane) => variantPalette("grove-dark")[lane])).toEqual([
    "#40c083",
    "#00bbbf",
    "#ffafd7",
    "#f8a236",
    "#66acff",
    "#bbc95d",
  ]);
  expect(variantPalette("ember-light").graphLane1).toBe("#b04d20");
  expect(variantPalette("iris-dark").graphLane1).toBe("#9b97fb");
});

const L1_INITIALS_CONTRAST =
  Math.floor(
    Math.min(
      ...(["light", "dark"] as const).flatMap((a) =>
        LANES.map((lane) =>
          ratio(stylesheet[a]["--on-lane"], stylesheet[a][TOKENS[lane]]),
        ),
      ),
    ) * 100,
  ) / 100;

it.each(derived.map((v) => [v.id, v.palette] as const))(
  "keeps %s lanes at 3:1 on the canvas, with initials as readable as L1's",
  (_, p) => {
    for (const lane of LANES) {
      expect(ratio(p[lane], p.background)).toBeGreaterThanOrEqual(3);
      expect(ratio(p.onLane, p[lane])).toBeGreaterThanOrEqual(
        L1_INITIALS_CONTRAST,
      );
      expect(ratio(p.refOnLane, p[lane])).toBeGreaterThanOrEqual(3);
    }
  },
);

it("switches initials to dark ink on a dark theme whose lanes leave white too faint", () => {
  expect(variantPalette("grove-dark").onLane).toBe("#ffffff");
  expect(variantPalette("rose-dark").onLane).toBe("#150d11");
});

it("puts dark ink on pale lanes a theme brings, and keeps white on deep ones", () => {
  const pale = Object.fromEntries(LANES.map((lane) => [lane, "#f1fa8c"]));
  const light = completePalette("light", {
    background: "#ffffff",
    accent: "#346bf1",
    ...pale,
  });
  expect([light.onLane, light.refOnLane]).toEqual(["#323232", "#323232"]);
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
    "#38bf93",
    "#172e25",
    "#01010177",
  ]);
  const ember = variantPalette("ember-light");
  expect([ember.errorBg, ember.accentMuted, ember.shadowPane]).toEqual([
    "#fbefed",
    "#91624c",
    "#18171726",
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
    "#344d45",
    "#3a5f4c",
  ]);
});
