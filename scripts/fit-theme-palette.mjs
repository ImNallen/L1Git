import { readFileSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";

// src imports omit the .ts extension, as Vite resolves them; Node needs it spelled out.
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (!specifier.startsWith(".")) throw error;
      return next(`${specifier}.ts`, context);
    }
  },
});

const { contrast, distance, formatHex, parseHex, toOklch } =
  await import("../src/themes/color.ts");
const {
  LANES,
  MAX_FIT_DISTANCE,
  RATIO_RECIPES,
  STYLESHEET_TOKENS: TOKENS,
  TRANSLUCENT,
  recipe,
} = await import("../src/themes/palette.ts");
const { stylesheetPalettes } = await import("../src/themes/stylesheet.ts");

const css = readFileSync(new URL("../src/theme.css", import.meta.url), "utf8");
const palettes = stylesheetPalettes(css);
const output = fileURLToPath(
  new URL("../src/themes/recipes.generated.ts", import.meta.url),
);

const SEEDS = {
  background: "--canvas",
  accent: "--primary-bg",
  foreground: "--text",
};
// Status colours keep L1's hue and chroma so green still means added; their lightness follows the theme.
const STATUS = [
  "warning",
  "success",
  "successMuted",
  "deleted",
  "errorText",
  "warningIcon",
];
// A status wash is the background tinted toward one of the status colours.
const WASHES = [
  "successBg",
  "successBgHover",
  "errorBg",
  "errorBorder",
  "warningBg",
  "warningBorder",
];
// Kinds in order of preference: a neutral surface stays neutral unless an accent kind fits clearly better.
const KINDS = ["ink", "shade", "tint", "lift", "glow", "glaze"];
// Ink may overshoot either end: a raised surface lighter than the background, or a heading brighter than body text.
const RANGE = { ink: [-0.25, 1.5], glow: [0, 1.5] };
const PREFER_WITHIN = 0.003;
const STEPS = 1000;
const WHITE = parseHex("#ffffff");

const rounded = (rgba) => parseHex(formatHex(rgba));
const round = (v, places) => Math.round(v * 10 ** places) / 10 ** places;
const steps = (lo = 0, hi = 1) =>
  Array.from(
    { length: Math.round((hi - lo) * STEPS) + 1 },
    (_, i) => Math.round(lo * STEPS + i) / STEPS,
  );

function fit(seeds, target) {
  const fits = KINDS.flatMap((kind) => {
    if (kind === "glaze" && target.a === 1) return [];
    let best = { kind, t: 0, d: Infinity };
    for (const t of steps(...(RANGE[kind] ?? []))) {
      const d = distance(rounded(RATIO_RECIPES[kind](t)(seeds)), target);
      const tie = Math.abs(d - best.d) < 1e-9 && Math.abs(t) < Math.abs(best.t);
      if (d < best.d - 1e-9 || tie) best = { kind, t, d };
    }
    return [best];
  });
  const min = Math.min(...fits.map((f) => f.d));
  return fits.find((f) => f.d <= min + PREFER_WITHIN);
}

/** The spec among `specs` that lands nearest `target`, earliest on a tie. */
function nearest(specs, seeds, get, target) {
  let best = { spec: specs[0], d: Infinity };
  for (const spec of specs) {
    const d = distance(rounded(recipe(spec)(seeds, get)), target);
    if (d < best.d - 1e-9) best = { spec, d };
  }
  return best;
}

// The target's lightness between the seeds' background and text, its chroma, and its hue, so L1's seeds give it back.
function polar(seeds, target) {
  const { L, C, h } = toOklch(target);
  const [bg, fg] = [toOklch(seeds.background).L, toOklch(seeds.foreground).L];
  return { t: round((L - bg) / (fg - bg), 3), C, h };
}

function fitHue(seeds, target) {
  const { t, C, h } = polar(seeds, target);
  const offset = ((h - toOklch(seeds.accent).h + 540) % 360) - 180;
  return ["hue", round(offset, 1), t, round(C, 4)];
}

function fitStatus(seeds, target) {
  const { t, C, h } = polar(seeds, target);
  return ["status", round(h, 1), t, round(C, 4)];
}

function fitTone(seeds, target) {
  const { t, C } = polar(seeds, target);
  return ["tone", t, round(C / toOklch(seeds.accent).C, 3)];
}

const fits = Object.fromEntries(
  ["dark", "light"].map((appearance) => {
    const values = palettes[appearance];
    const color = (name) => {
      const parsed = parseHex(values[name] ?? "");
      if (!parsed)
        throw new Error(`theme.css has no hex ${name} for ${appearance}`);
      return parsed;
    };
    const seeds = {
      background: color(SEEDS.background),
      accent: color(SEEDS.accent),
      foreground: color(SEEDS.foreground),
    };
    const table = {};
    // A recipe that reads another token reads what that token derives, as the app does.
    const get = (token) =>
      table[token]
        ? rounded(recipe(table[token])(seeds, get))
        : color(TOKENS[token]);
    for (const lane of LANES) table[lane] = fitHue(seeds, color(TOKENS[lane]));
    for (const token of STATUS)
      table[token] = fitStatus(seeds, color(TOKENS[token]));
    return [appearance, { color, seeds, table, get }];
  }),
);

// Ref names need 3:1 on a lane. Initials keep white down to the contrast L1's own initials have on its palest lane,
// to two places so rounding a derived lane can't flip L1's.
const LANE_INK_MINIMUM = {
  refOnLane: 3,
  onLane:
    Math.floor(
      Math.min(
        ...Object.values(fits).flatMap(({ get }) =>
          LANES.map((lane) => contrast(WHITE, get(lane))),
        ),
      ) * 100,
    ) / 100,
};

function fitToken(token, { seeds, get }, target) {
  if (Object.hasOwn(SEEDS, token)) return { spec: ["seed", token] };
  if (token === "accentForeground") return { spec: ["onAccent"] };
  if (Object.hasOwn(LANE_INK_MINIMUM, token))
    return nearest(
      steps().map((t) => ["laneInk", LANE_INK_MINIMUM[token], t]),
      seeds,
      get,
      target,
    );
  if (WASHES.includes(token))
    return nearest(
      STATUS.flatMap((status) => steps().map((t) => ["toward", status, t])),
      seeds,
      get,
      target,
    );
  if (TRANSLUCENT.has(token))
    return nearest(
      steps().map((t) => ["shadow", t, round(target.a, 3)]),
      seeds,
      get,
      target,
    );
  const best = fit(seeds, target);
  if (best.d <= MAX_FIT_DISTANCE) return { spec: [best.kind, best.t] };
  const tone = nearest([fitTone(seeds, target)], seeds, get, target);
  const spec =
    tone.d <= MAX_FIT_DISTANCE ? tone.spec : ["fixed", formatHex(target)];
  return { spec, note: `best ${best.kind}(${best.t}) at ${best.d.toFixed(4)}` };
}

const recipes = {};
const foregroundMix = {};
const report = [];
for (const [appearance, fitted] of Object.entries(fits)) {
  const { color, seeds, table, get } = fitted;
  const toward = appearance === "dark" ? WHITE : parseHex("#000000");
  const foreground = nearest(
    steps().map((t) => ["ink", t]),
    { ...seeds, foreground: toward },
    get,
    seeds.foreground,
  );
  foregroundMix[appearance] = foreground.spec[1];
  report.push(
    `${appearance} foreground: ${foreground.spec[1]} at ${foreground.d.toFixed(4)}`,
  );

  const ordered = {};
  let worst = { token: "", d: 0 };
  for (const [token, name] of Object.entries(TOKENS)) {
    const target = color(name);
    if (!table[token]) {
      const { spec, note } = fitToken(token, fitted, target);
      table[token] = spec;
      if (note)
        report.push(
          `${appearance} ${token}: no ratio recipe within ${MAX_FIT_DISTANCE} (${note}), ${spec[0]}`,
        );
    }
    ordered[token] = table[token];
    const d = distance(get(token), target);
    if (d > MAX_FIT_DISTANCE)
      throw new Error(`${appearance} ${token} misses theme.css by ${d}`);
    if (d > worst.d) worst = { token, d };
  }
  recipes[appearance] = ordered;
  report.push(`${appearance} worst: ${worst.token} at ${worst.d.toFixed(4)}`);
}

const source = `// Generated by scripts/fit-theme-palette.mjs from src/theme.css. Do not edit.
import type { Appearance, RecipeSpec, StylesheetToken } from "./palette";

export const FOREGROUND_MIX: Record<Appearance, number> = ${JSON.stringify(foregroundMix)};

export const RECIPES: Record<Appearance, Record<StylesheetToken, RecipeSpec>> = ${JSON.stringify(recipes)};
`;
writeFileSync(
  output,
  await format(source, {
    ...(await resolveConfig(output)),
    filepath: output,
  }),
);
console.error(report.join("\n"));
