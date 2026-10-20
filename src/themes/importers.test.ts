import { expect, it } from "vitest";
import {
  asVsCodeTheme,
  mergeVsCodeThemes,
  parseThemeFile,
  vsCodeThemeToDraft,
} from "./importers";

// Trimmed from dracula-theme.theme-dracula 2.25.1 on Open VSX (MIT).
const DRACULA = `{
  "name": "Dracula",
  "colors": {
    "editor.background": "#282A36",
    "editor.foreground": "#F8F8F2",
    "foreground": "#F8F8F2",
    "sideBar.background": "#21222C",
    "activityBar.background": "#343746",
    "panel.background": "#282A36",
    "editorWidget.background": "#21222C",
    "list.hoverBackground": "#44475A75",
    "list.activeSelectionBackground": "#44475A",
    "panel.border": "#BD93F9",
    "editorGroup.border": "#BD93F9",
    "focusBorder": "#6272A4",
    "button.background": "#44475A",
    "activityBarBadge.background": "#FF79C6",
    "editor.selectionBackground": "#44475A",
    "editor.selectionHighlightBackground": "#424450",
    "editor.findMatchBackground": "#FFB86C80",
    "editor.findMatchHighlightBackground": "#FFFFFF40",
    "errorForeground": "#FF5555",
    "terminal.ansiGreen": "#50FA7B",
    "terminal.ansiYellow": "#F1FA8C",
    "terminal.ansiBlue": "#BD93F9",
    "terminal.ansiCyan": "#8BE9FD",
    "gitDecoration.modifiedResourceForeground": "#8BE9FD",
    "gitDecoration.deletedResourceForeground": "#FF5555",
    "textLink.foreground": "#8BE9FD",
  },
  "tokenColors": [
    {"scope": ["comment", "punctuation.definition.comment", "unused.comment", "wildcard.comment"], "settings": {"foreground": "#6272A4"}},
    {"scope": ["keyword", "punctuation.definition.keyword"], "settings": {"foreground": "#FF79C6"}},
    {"scope": ["string"], "settings": {"foreground": "#F1FA8C"}},
  ],
}`;

it("maps a VS Code theme onto L1 Git tokens, flattening translucent surfaces onto the background", () => {
  expect(parseThemeFile(DRACULA, "dracula.json")).toEqual({
    ok: true,
    family: {
      name: "Dracula",
      variants: [
        {
          name: "Dracula",
          appearance: "dark",
          colors: {
            background: "#282a36",
            foreground: "#f8f8f2",
            sidebar: "#21222c",
            panel: "#282a36",
            panelRaised: "#21222c",
            rowHover: "#353747",
            rowSelected: "#44475a",
            accent: "#ff79c6",
            focus: "#6272a4",
            link: "#8be9fd",
            selectionBg: "#44475a",
            success: "#50fa7b",
            warning: "#8be9fd",
            deleted: "#ff5555",
            errorText: "#ff5555",
            graphLane1: "#bd93f9",
            graphLane3: "#8be9fd",
            graphLane4: "#f1fa8c",
            graphLane6: "#50fa7b",
            syntaxKeyword: "#ff79c6",
            syntaxString: "#f1fa8c",
            syntaxStringExpression: "#f1fa8c",
            syntaxComment: "#6272a4",
          },
        },
      ],
    },
  });
});

it("reads syntax colours from the last TextMate rule naming each scope, flattening alpha onto the background", () => {
  const theme = asVsCodeTheme({
    colors: { "editor.background": "#000000" },
    tokenColors: [
      { scope: "keyword, storage.type", settings: { foreground: "#ff0000" } },
      { scope: "keyword.control", settings: { foreground: "#00ff00" } },
      { scope: ["keyword"], settings: { foreground: "#0000ff" } },
      { scope: "comment", settings: { fontStyle: "italic" } },
      { scope: "comment", settings: { foreground: "#ffffff80" } },
      { scope: "constant.numeric", settings: { foreground: "#ffb86c" } },
    ],
  });
  expect(theme && vsCodeThemeToDraft(theme, "x").colors).toEqual({
    background: "#000000",
    accent: "#346bf1",
    syntaxKeyword: "#0000ff",
    syntaxConstant: "#ffb86c",
    syntaxComment: "#808080",
  });
});

it("reads a syntax colour from a narrower or compound scope when no rule names the scope itself", () => {
  const theme = asVsCodeTheme({
    colors: { "editor.background": "#000000" },
    tokenColors: [
      { scope: "keyword.control", settings: { foreground: "#ff0000" } },
      { scope: "keyword.operator", settings: { foreground: "#00ff00" } },
      { scope: "source.js string", settings: { foreground: "#ffff00" } },
      { scope: "comment.line", settings: { foreground: "#888888" } },
      {
        scope: "punctuation.definition.string",
        settings: { foreground: "#ff00ff" },
      },
    ],
  });
  expect(theme && vsCodeThemeToDraft(theme, "x").colors).toEqual({
    background: "#000000",
    accent: "#346bf1",
    syntaxKeyword: "#00ff00",
    syntaxString: "#ffff00",
    syntaxStringExpression: "#ffff00",
    syntaxComment: "#888888",
  });
});

it("prefers a rule naming the scope over a later compound or narrower one, as Dracula's resets need", () => {
  const theme = asVsCodeTheme({
    colors: { "editor.background": "#000000" },
    tokenColors: [
      { scope: "string", settings: { foreground: "#f1fa8c" } },
      { scope: "constant", settings: { foreground: "#bd93f9" } },
      {
        scope: [
          "meta.scope.for-loop.shell string",
          "constant.language.empty-list.haskell",
        ],
        settings: { foreground: "#f8f8f2" },
      },
    ],
  });
  expect(theme && vsCodeThemeToDraft(theme, "x").colors).toEqual({
    background: "#000000",
    accent: "#346bf1",
    syntaxString: "#f1fa8c",
    syntaxStringExpression: "#f1fa8c",
    syntaxConstant: "#bd93f9",
  });
});

it("colours quoted strings, which Shiki paints as string expressions, with the theme's string rule", () => {
  const theme = asVsCodeTheme({
    colors: { "editor.background": "#000000" },
    tokenColors: [
      { scope: "string", settings: { foreground: "#9ece6a" } },
      { scope: "string.regexp", settings: { foreground: "#b4f9f8" } },
    ],
  });
  expect(theme && vsCodeThemeToDraft(theme, "x").colors).toEqual({
    background: "#000000",
    accent: "#346bf1",
    syntaxString: "#9ece6a",
    syntaxStringExpression: "#9ece6a",
  });
});

it("takes the appearance from the manifest's uiTheme, then the theme's type, then the background", () => {
  const theme = asVsCodeTheme({ colors: { "editor.background": "#1e1e1e" } });
  expect(
    theme && [
      vsCodeThemeToDraft(theme, "x", "vs").appearance,
      vsCodeThemeToDraft(theme, "x").appearance,
    ],
  ).toEqual(["light", "dark"]);
  expect(
    parseThemeFile(
      '{ "type": "light", "colors": { "editor.background": "#000000" } }',
    ),
  ).toMatchObject({
    ok: true,
    family: { variants: [{ appearance: "light" }] },
  });
  expect(
    parseThemeFile(
      '{ "colors": { "editor.background": "#fdf6e3" } }',
      "solarized-light.json",
    ),
  ).toEqual({
    ok: true,
    family: {
      name: "solarized-light",
      variants: [
        {
          name: "solarized-light",
          appearance: "light",
          colors: { background: "#fdf6e3", accent: "#1b4ed8" },
        },
      ],
    },
  });
});

it.each(["constructor", "__proto__", "toString"])(
  "reads the appearance from the background when the base theme is %j",
  (base) => {
    const theme = asVsCodeTheme({
      type: base,
      colors: { "editor.background": "#fdf6e3" },
    });
    expect(theme && vsCodeThemeToDraft(theme, "x", base)).toEqual({
      name: "x",
      appearance: "light",
      colors: { background: "#fdf6e3", accent: "#1b4ed8" },
    });
  },
);

it("skips a fully transparent colour, which VS Code themes use to hide an element", () => {
  const text = JSON.stringify({
    colors: {
      "editor.background": "#1e1e2e",
      "sideBar.border": "#00000000",
      "editorGroup.border": "#585b70",
      "input.border": "#00000000",
    },
  });
  expect(parseThemeFile(text, "mocha.json")).toEqual({
    ok: true,
    family: {
      name: "mocha",
      variants: [
        {
          name: "mocha",
          appearance: "dark",
          colors: {
            background: "#1e1e2e",
            border: "#585b70",
            accent: "#346bf1",
          },
        },
      ],
    },
  });
});

it("lets an including theme override the colours and syntax rules it includes", () => {
  const parent = asVsCodeTheme({
    name: "Base",
    colors: {
      "editor.background": "#101010",
      "button.background": "#ff0000",
      "terminal.ansiGreen": "#00cc00",
    },
    tokenColors: [
      { scope: "keyword", settings: { foreground: "#cc00cc" } },
      { scope: "string", settings: { foreground: "#ffff00" } },
    ],
  });
  const child = asVsCodeTheme({
    name: "Child",
    include: "./base.json",
    colors: { "button.background": "#00ff00" },
    tokenColors: [{ scope: "string", settings: { foreground: "#00ffff" } }],
  });
  const merged =
    parent &&
    child &&
    vsCodeThemeToDraft(mergeVsCodeThemes(parent, child), "x");
  expect(merged).toEqual({
    name: "Child",
    appearance: "dark",
    colors: {
      background: "#101010",
      accent: "#00ff00",
      success: "#00cc00",
      graphLane6: "#00cc00",
      syntaxKeyword: "#cc00cc",
      syntaxString: "#00ffff",
      syntaxStringExpression: "#00ffff",
    },
  });
});

it("reads an L1 theme, dropping unknown keys and flattening alpha on opaque tokens", () => {
  const text = JSON.stringify({
    version: 1,
    name: " Aurora ",
    appearance: "light",
    colors: {
      background: "#ffffff",
      accent: "#7c3aed",
      sidebar: "#00000080",
      shadowDialog: "#15152533",
      sparkle: "#123456",
      muted: "grey",
    },
  });
  expect(parseThemeFile(text)).toEqual({
    ok: true,
    family: {
      name: "Aurora",
      variants: [
        {
          name: "Aurora",
          appearance: "light",
          colors: {
            background: "#ffffff",
            accent: "#7c3aed",
            sidebar: "#7f7f7f",
            shadowDialog: "#15152533",
          },
        },
      ],
    },
  });
});

it("imports an L1 Data theme file, keeping the seeds and the tokens both apps share", () => {
  const text = JSON.stringify({
    version: 1,
    name: "Harbor",
    appearance: "dark",
    colors: {
      background: "#0b1220",
      accent: "#38bdf8",
      foreground: "#e2e8f0",
      keyword: "#f472b6",
      border: "#1e293b",
      codeSelection: "#1e3a5f",
    },
  });
  expect(parseThemeFile(text)).toEqual({
    ok: true,
    family: {
      name: "Harbor",
      variants: [
        {
          name: "Harbor",
          appearance: "dark",
          colors: {
            background: "#0b1220",
            accent: "#38bdf8",
            foreground: "#e2e8f0",
            border: "#1e293b",
          },
        },
      ],
    },
  });
});

it.each([
  ['{ "colors": { ', "Invalid JSON on line 1: CloseBraceExpected."],
  ['{\n  "version": 1,\n  "name": }', "Invalid JSON on line 3: ValueExpected."],
  ["[1, 2]", "Not a theme: expected an L1 theme or a VS Code color theme."],
  [
    '{ "hello": "world" }',
    "Not a theme: expected an L1 theme or a VS Code color theme.",
  ],
  [
    '{ "version": 2, "name": "A", "appearance": "dark", "colors": {} }',
    "Unsupported theme version; expected 1.",
  ],
  [
    '{ "version": 1, "name": "", "appearance": "dark", "colors": {} }',
    "The theme needs a name.",
  ],
  [
    '{ "version": 1, "name": "A", "appearance": "dim", "colors": {} }',
    'appearance must be "light" or "dark".',
  ],
  [
    '{ "version": 1, "name": "A", "appearance": "dark", "colors": { "background": "#000" } }',
    "colors.background and colors.accent must be hex colours.",
  ],
  [
    '{ "include": "./base.json", "colors": { "editor.background": "#101010" } }',
    "This theme includes ./base.json, which can't be read from a single file. Import its extension from Open VSX instead.",
  ],
])("rejects %s", (text, error) => {
  expect(parseThemeFile(text)).toEqual({ ok: false, error });
});
