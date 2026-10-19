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

const { contrast, distance, formatHex, mix, parseHex, toOklch } =
  await import("../src/themes/color.ts");
const { LANES, MAX_FIT_DISTANCE, RATIO_RECIPES, TOKENS, TRANSLUCENT, recipe } =
  await import("../src/themes/palette.ts");
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
const PINNED = new Set([
  ...TRANSLUCENT,
  "warning",
  "success",
  "successMuted",
  "successBg",
  "successBgHover",
  "deleted",
  "errorText",
  "errorBg",
  "errorBorder",
  "warningIcon",
  "warningBg",
  "warningBorder",
]);
// Kinds in order of preference: a neutral surface stays neutral unless an accent kind fits clearly better.
const KINDS = ["ink", "shade", "tint", "lift", "glow", "glaze"];
// Ink may overshoot either end: a raised surface lighter than the background, or a heading brighter than body text.
const RANGE = { ink: [-0.25, 1.5], glow: [0, 1.5] };
const PREFER_WITHIN = 0.003;
const STEPS = 1000;

const rounded = (rgba) => parseHex(formatHex(rgba));

function fit(seeds, target) {
  const fits = KINDS.flatMap((kind) => {
    if (kind === "glaze" && target.a === 1) return [];
    const [lo, hi] = RANGE[kind] ?? [0, 1];
    let best = { kind, t: 0, d: Infinity };
    for (let i = 0; i <= (hi - lo) * STEPS; i++) {
      const t = Math.round(lo * STEPS + i) / STEPS;
      const d = distance(rounded(RATIO_RECIPES[kind](t)(seeds)), target);
      const tie = Math.abs(d - best.d) < 1e-9 && Math.abs(t) < Math.abs(best.t);
      if (d < best.d - 1e-9 || tie) best = { kind, t, d };
    }
    return [best];
  });
  const min = Math.min(...fits.map((f) => f.d));
  return fits.find((f) => f.d <= min + PREFER_WITHIN);
}

function fitTowards(from, to, target) {
  let best = { t: 0, d: Infinity };
  for (let i = 0; i <= STEPS; i++) {
    const t = i / STEPS;
    const d = distance(rounded(mix(from, to, t)), target);
    if (d < best.d) best = { t, d };
  }
  return best;
}

const round = (v, places) => Math.round(v * 10 ** places) / 10 ** places;

// The lane's own lightness, chroma, and hue as seen from the seeds, so L1's seeds give back L1's lane.
function fitHue(seeds, target) {
  const [lane, accent] = [toOklch(target), toOklch(seeds.accent)];
  const [bg, fg] = [toOklch(seeds.background).L, toOklch(seeds.foreground).L];
  const offset = ((lane.h - accent.h + 540) % 360) - 180;
  return [
    "hue",
    round(offset, 1),
    round((lane.L - bg) / (fg - bg), 3),
    round(lane.C, 4),
  ];
}

function fitLaneInk(seeds, minWhite, target, get) {
  let best = { spec: ["laneInk", minWhite, 0], d: Infinity };
  for (let i = 0; i <= STEPS; i++) {
    const spec = ["laneInk", minWhite, i / STEPS];
    const d = distance(rounded(recipe(spec)(seeds, get)), target);
    if (d < best.d - 1e-9) best = { spec, d };
  }
  return best.spec;
}

const WHITE = parseHex("#ffffff");

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
    return [appearance, { values, color, seeds, table, get }];
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

const recipes = {};
const foregroundMix = {};
const report = [];
for (const [appearance, { values, color, seeds, table, get }] of Object.entries(
  fits,
)) {
  const toward = appearance === "dark" ? WHITE : parseHex("#000000");
  const foreground = fitTowards(seeds.background, toward, seeds.foreground);
  foregroundMix[appearance] = foreground.t;
  report.push(
    `${appearance} foreground: ${foreground.t} at ${foreground.d.toFixed(4)}`,
  );

  const ordered = {};
  let worst = { token: "", d: 0 };
  for (const [token, name] of Object.entries(TOKENS)) {
    const target = color(name);
    if (Object.hasOwn(SEEDS, token)) table[token] = ["seed", token];
    else if (token === "accentForeground") table[token] = ["onAccent"];
    else if (Object.hasOwn(LANE_INK_MINIMUM, token))
      table[token] = fitLaneInk(seeds, LANE_INK_MINIMUM[token], target, get);
    else if (PINNED.has(token)) table[token] = ["fixed", values[name]];
    else if (!LANES.includes(token)) {
      const best = fit(seeds, target);
      table[token] =
        best.d > MAX_FIT_DISTANCE
          ? ["fixed", values[name]]
          : [best.kind, best.t];
      if (best.d > MAX_FIT_DISTANCE)
        report.push(
          `${appearance} ${token}: no recipe within ${MAX_FIT_DISTANCE} (best ${best.kind}(${best.t}) at ${best.d.toFixed(4)}), fixed`,
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
import type { Appearance, RecipeSpec, Token } from "./palette";

export const FOREGROUND_MIX: Record<Appearance, number> = ${JSON.stringify(foregroundMix)};

export const RECIPES: Record<Appearance, Record<Token, RecipeSpec>> = ${JSON.stringify(recipes)};
`;
writeFileSync(
  output,
  await format(source, {
    ...(await resolveConfig(output)),
    filepath: output,
  }),
);
console.error(report.join("\n"));
