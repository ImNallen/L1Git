import { expect, it } from "vitest";
import {
  addCustomThemes,
  BUILT_IN_FAMILIES,
  chooseThemes,
  customVariant,
  DEFAULT_THEME_SETTINGS,
  deleteCustomTheme,
  draftOf,
  familyPicks,
  resolveTheme,
  themeFamilies,
  type CustomTheme,
  type CustomThemeVariant,
  type ThemeSettings,
} from "./catalog";

const defaults = DEFAULT_THEME_SETTINGS;
const duskVariant: CustomThemeVariant = {
  id: "custom-dusk",
  name: "Dusk",
  appearance: "dark",
  colors: { background: "#1b1824", accent: "#e0a040" },
};
const dusk: CustomTheme = {
  id: "custom-dusk-family",
  name: "Dusk",
  variants: [duskVariant],
};
const variantById = (id: string) =>
  themeFamilies([])
    .flatMap((f) => f.variants)
    .find((v) => v.id === id);

it.each([
  ["system", true, "l1-dark"],
  ["system", false, "l1-light"],
  ["light", true, "l1-light"],
  ["dark", false, "l1-dark"],
] as const)(
  "resolves the %s scheme with a dark system %s to %s by default",
  (colorScheme, systemDark, id) => {
    expect(resolveTheme({ ...defaults, colorScheme }, systemDark).id).toBe(id);
  },
);

it("resolves the pick for the scheme's appearance", () => {
  const settings = {
    ...defaults,
    lightTheme: "ocean-light",
    darkTheme: "ember-dark",
  };
  expect([
    resolveTheme(settings, false).id,
    resolveTheme(settings, true).id,
  ]).toEqual(["ocean-light", "ember-dark"]);
});

it("falls back to L1 of the slot's appearance when the id is unknown or names the other appearance", () => {
  expect(
    resolveTheme({ ...defaults, darkTheme: "deleted-theme" }, true).id,
  ).toBe("l1-dark");
  expect(
    resolveTheme({ ...defaults, lightTheme: "grove-dark" }, false).id,
  ).toBe("l1-light");
  expect(
    resolveTheme(
      { ...defaults, lightTheme: "custom-dusk", customThemes: [dusk] },
      false,
    ).id,
  ).toBe("l1-light");
});

it("resolves a custom theme to its stored colours over a palette derived from its background and accent", () => {
  const tuned = {
    ...duskVariant,
    colors: { ...duskVariant.colors, sidebar: "#000000" },
  };
  const variant = resolveTheme(
    {
      ...defaults,
      darkTheme: "custom-dusk",
      customThemes: [{ ...dusk, variants: [tuned] }],
    },
    true,
  );
  expect([variant.id, variant.name, variant.appearance]).toEqual([
    "custom-dusk",
    "Dusk",
    "dark",
  ]);
  expect(variant.swatch).toEqual({ background: "#1b1824", accent: "#e0a040" });
  expect([
    variant.palette.background,
    variant.palette.accent,
    variant.palette.sidebar,
    variant.palette.panelRaised,
  ]).toEqual(["#1b1824", "#e0a040", "#000000", "#211f2a"]);
});

it("paints L1 from the stylesheet with no inline palette", () => {
  expect(resolveTheme(defaults, true).palette).toEqual({});
  expect(resolveTheme(defaults, false).palette).toEqual({});
});

it("duplicates a variant as its seeds plus only the colours they don't derive", () => {
  const groveDark = variantById("grove-dark");
  expect(groveDark && draftOf(groveDark, "Grove copy")).toEqual({
    name: "Grove copy",
    appearance: "dark",
    colors: { background: "#0c1310", accent: "#2f9e6e" },
  });
  const tuned = customVariant({
    ...duskVariant,
    colors: { ...duskVariant.colors, link: "#ff00ff" },
  });
  expect(draftOf(tuned, "Dusk copy").colors).toEqual({
    background: "#1b1824",
    accent: "#e0a040",
    link: "#ff00ff",
  });
});

const variant = (
  id: string,
  name: string,
  appearance: "light" | "dark",
  background: string,
): CustomThemeVariant => ({
  id,
  name,
  appearance,
  colors: { background, accent: "#cba6f7" },
});

const catppuccin: CustomTheme = {
  id: "custom-cat",
  name: "Catppuccin",
  variants: [
    variant("custom-cat-0", "Mocha", "dark", "#1e1e2e"),
    variant("custom-cat-1", "Latte", "light", "#eff1f5"),
    variant("custom-cat-2", "Frappe", "dark", "#303446"),
  ],
};

it("shows each stored theme as one family, light variants first, and skips a theme with no variants", () => {
  const customs = themeFamilies([
    catppuccin,
    { id: "custom-empty", name: "Empty", variants: [] },
  ]).filter((f) => f.custom);
  expect(
    customs.map((f) => [f.id, f.name, f.variants.map((v) => v.id)]),
  ).toEqual([
    [
      "custom-cat",
      "Catppuccin",
      ["custom-cat-1", "custom-cat-0", "custom-cat-2"],
    ],
  ]);
  expect(customs[0] && familyPicks(customs[0]).map((v) => v.id)).toEqual([
    "custom-cat-1",
    "custom-cat-0",
  ]);
});

it("resolves any variant of a family for its own appearance only", () => {
  const settings = {
    ...defaults,
    lightTheme: "custom-cat-2",
    darkTheme: "custom-cat-2",
    customThemes: [catppuccin],
  };
  expect([
    resolveTheme(settings, false).id,
    resolveTheme(settings, true).id,
  ]).toEqual(["l1-light", "custom-cat-2"]);
});

const grove = BUILT_IN_FAMILIES.find((f) => f.id === "grove");

it("picks a family's light and dark variant and keeps the scheme", () => {
  const picked = chooseThemes(
    { ...defaults, colorScheme: "dark" },
    grove ? familyPicks(grove) : [],
  );
  expect(picked).toEqual({
    colorScheme: "dark",
    lightTheme: "grove-light",
    darkTheme: "grove-dark",
    customThemes: [],
  });
});

it("switches a pinned scheme to the appearance of a pick it would hide", () => {
  const irisLight = variantById("iris-light");
  const pinnedDark: ThemeSettings = { ...defaults, colorScheme: "dark" };
  expect(chooseThemes(pinnedDark, irisLight ? [irisLight] : [])).toEqual({
    ...pinnedDark,
    colorScheme: "light",
    lightTheme: "iris-light",
  });
  expect(chooseThemes(defaults, irisLight ? [irisLight] : []).colorScheme).toBe(
    "system",
  );
});

it("adds a family as one stored theme and picks its variants", () => {
  const added = addCustomThemes(
    { ...defaults, colorScheme: "light" },
    [
      {
        name: "Night",
        variants: [
          {
            name: "Night Dark",
            appearance: "dark",
            colors: { background: "#101018", accent: "#e0457b" },
          },
        ],
      },
    ],
    () => "abc",
  );
  expect(added).toEqual({
    colorScheme: "dark",
    lightTheme: "l1-light",
    darkTheme: "custom-abc-0",
    customThemes: [
      {
        id: "custom-abc",
        name: "Night",
        variants: [
          {
            id: "custom-abc-0",
            name: "Night Dark",
            appearance: "dark",
            colors: { background: "#101018", accent: "#e0457b" },
          },
        ],
      },
    ],
  });
});

it("deletes a custom family and sends each appearance that used it back to L1", () => {
  const settings: ThemeSettings = {
    colorScheme: "system",
    lightTheme: "custom-cat-1",
    darkTheme: "grove-dark",
    customThemes: [catppuccin, dusk],
  };
  expect(deleteCustomTheme(settings, "custom-cat")).toEqual({
    colorScheme: "system",
    lightTheme: "l1-light",
    darkTheme: "grove-dark",
    customThemes: [dusk],
  });
});
