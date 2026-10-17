import { describe, expect, it } from "vitest";
import { parseThemePreference, resolveTheme } from "./appearance";

describe("stored theme preference", () => {
  it.each([
    ["system", "system"],
    ["light", "light"],
    ["dark", "dark"],
    [null, "system"],
    [undefined, "system"],
    ["", "system"],
    ["Dark", "system"],
    ['"light"', "system"],
    ["unknown", "system"],
    [{ theme: "dark" }, "system"],
  ])("reads %j as %s", (stored, expected) => {
    expect(parseThemePreference(stored)).toBe(expected);
  });
});

describe("resolved theme", () => {
  it("follows operating system changes in System", () => {
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("system", true)).toBe("dark");
  });

  it("keeps explicit choices regardless of the operating system", () => {
    expect(resolveTheme("light", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("dark", true)).toBe("dark");
  });
});
