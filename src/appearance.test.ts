import { describe, expect, it } from "vitest";
import { parseAppearanceSettings } from "./appearance";

const defaults = {
  colorScheme: "system",
  lightTheme: "l1-light",
  darkTheme: "l1-dark",
  customThemes: [],
};

describe("stored appearance settings", () => {
  it.each([
    ["system", "system"],
    ["light", "light"],
    ["dark", "dark"],
  ])("keeps the scheme of a bare %j saved before themes", (stored, scheme) => {
    expect(parseAppearanceSettings(stored)).toEqual({
      ...defaults,
      colorScheme: scheme,
    });
  });

  it.each([
    null,
    "",
    "Dark",
    '"light"',
    "unknown",
    "not json",
    "5",
    "[]",
    "null",
  ])("reads %j as the defaults", (stored) => {
    expect(parseAppearanceSettings(stored)).toEqual(defaults);
  });

  it("reads saved settings with their picks and custom themes", () => {
    const saved = {
      colorScheme: "dark",
      lightTheme: "grove-light",
      darkTheme: "custom-1-0",
      customThemes: [
        {
          id: "custom-1",
          name: "Dusk",
          variants: [
            {
              id: "custom-1-0",
              name: "Dusk",
              appearance: "dark",
              colors: { background: "#202020", accent: "#ff0000" },
            },
          ],
        },
      ],
    };
    expect(parseAppearanceSettings(JSON.stringify(saved))).toEqual(saved);
  });

  it("drops unknown tokens and colours that are not hex from a custom theme", () => {
    const stored = JSON.stringify({
      ...defaults,
      customThemes: [
        {
          id: "custom-1",
          name: "Dusk",
          variants: [
            {
              id: "custom-1-0",
              name: "Dusk",
              appearance: "dark",
              colors: {
                background: " #202020 ",
                accent: "#ff0000",
                link: "#123456",
                bogus: "#ffffff",
                muted: "red",
                sidebar: 7,
              },
            },
          ],
        },
      ],
    });
    expect(
      parseAppearanceSettings(stored).customThemes[0]?.variants[0]?.colors,
    ).toEqual({ background: "#202020", accent: "#ff0000", link: "#123456" });
  });

  it("keeps the well-formed custom themes when another is malformed", () => {
    const dusk = {
      id: "custom-1",
      name: "Dusk",
      variants: [
        {
          id: "custom-1-0",
          name: "Dusk",
          appearance: "dark",
          colors: { background: "#202020", accent: "#ff0000" },
        },
      ],
    };
    const stored = JSON.stringify({
      ...defaults,
      customThemes: [
        { id: "custom-2", name: "Broken", variants: "none" },
        dusk,
      ],
    });
    expect(parseAppearanceSettings(stored).customThemes).toEqual([dusk]);
  });

  it("falls back field by field when one setting is invalid", () => {
    const stored = JSON.stringify({
      colorScheme: "sepia",
      lightTheme: "ocean-light",
      darkTheme: 4,
      customThemes: [{ id: "custom-1", variants: "none" }],
    });
    expect(parseAppearanceSettings(stored)).toEqual({
      ...defaults,
      lightTheme: "ocean-light",
    });
  });
});
