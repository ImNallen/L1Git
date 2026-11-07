import { resolveTheme } from "@pierre/diffs";
import { expect, it } from "vitest";
import { diffTheme } from "./diffTheme";

it("uses restrained syntax for the default L1 appearance", () => {
  expect([diffTheme("light", false), diffTheme("dark", false)]).toEqual([
    "l1-muted-light",
    "l1-muted-dark",
  ]);
});

it.each(["light", "dark"] as const)(
  "highlights a painted %s theme with its palette's syntax tokens",
  async (appearance) => {
    const theme = await resolveTheme(diffTheme(appearance, true));
    // Shiki stands a placeholder in for each CSS variable and restores it when it paints.
    const color = (scope: string) => {
      const placeholder = theme.settings.find((rule) =>
        [rule.scope].flat().includes(scope),
      )?.settings.foreground;
      return placeholder && theme.colorReplacements?.[placeholder];
    };
    expect(theme.type).toBe(appearance);
    expect([
      color("keyword"),
      color("comment"),
      color("string"),
      color("markup.inserted"),
    ]).toEqual([
      "var(--diffs-token-keyword, var(--syntax-keyword))",
      "var(--diffs-token-comment, var(--syntax-comment))",
      "var(--diffs-token-string, var(--syntax-string))",
      "var(--diffs-token-inserted, var(--success))",
    ]);
  },
);
