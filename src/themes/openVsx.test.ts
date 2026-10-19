import { strToU8, zipSync } from "fflate";
import { afterEach, expect, it, vi } from "vitest";
import {
  fetchExtensionThemes,
  searchThemes,
  type VsxExtension,
} from "./openVsx";

afterEach(() => vi.unstubAllGlobals());

const serve = (routes: Record<string, () => Response>) => {
  const requested: string[] = [];
  vi.stubGlobal("fetch", (url: string) => {
    requested.push(url);
    return Promise.resolve(
      routes[url]?.() ?? new Response("missing", { status: 404 }),
    );
  });
  return requested;
};

const ext: VsxExtension = {
  id: "acme.night",
  displayName: "Night",
  publisher: "acme",
  description: "",
  downloadCount: 0,
  download: "https://cdn.test/night.vsix",
};

it("searches the Themes category by downloads and keeps only well-formed extensions", async () => {
  const body = {
    extensions: [
      {
        namespace: "dracula-theme",
        name: "theme-dracula",
        displayName: "Dracula Theme Official",
        description: "Dark",
        downloadCount: 435372,
        files: { download: "https://x/d.vsix" },
      },
      { namespace: "broken", name: "no-files" },
    ],
  };
  const requested = serve({
    "https://open-vsx.org/api/-/search?query=tokyo+night&category=Themes&size=20&sortBy=downloadCount&sortOrder=desc":
      () => Response.json(body),
  });
  expect(await searchThemes("tokyo night")).toEqual([
    {
      id: "dracula-theme.theme-dracula",
      displayName: "Dracula Theme Official",
      publisher: "dracula-theme",
      description: "Dark",
      downloadCount: 435372,
      download: "https://x/d.vsix",
    },
  ]);
  expect(requested).toHaveLength(1);
});

it("imports every theme an extension contributes, following includes inside the package", async () => {
  const manifest = {
    contributes: {
      themes: [
        { label: "Night Dark", uiTheme: "vs-dark", path: "./themes/dark.json" },
        { label: "Night Light", uiTheme: "vs", path: "./themes/light.json" },
      ],
    },
  };
  const vsix = zipSync({
    "extension/package.json": strToU8(JSON.stringify(manifest)),
    "extension/themes/base.json": strToU8(
      '{ "colors": { "editor.background": "#101018", "button.background": "#e0457b" } }',
    ),
    "extension/themes/dark.json": strToU8(
      '// dark\n{ "include": "./base.json", "colors": { "sideBar.background": "#08080c", }, }',
    ),
    "extension/themes/light.json": strToU8(
      '{ "colors": { "editor.background": "#fafafa", "focusBorder": "#1477b0" } }',
    ),
  });
  serve({ [ext.download]: () => new Response(vsix) });
  expect(await fetchExtensionThemes(ext)).toEqual({
    ok: true,
    family: {
      name: "Night",
      variants: [
        {
          name: "Night Dark",
          appearance: "dark",
          colors: {
            background: "#101018",
            sidebar: "#08080c",
            accent: "#e0457b",
          },
        },
        {
          name: "Night Light",
          appearance: "light",
          colors: {
            background: "#fafafa",
            accent: "#1477b0",
            focus: "#1477b0",
          },
        },
      ],
    },
  });
});

it("names the family after the extension and keeps two dark themes as two variants", async () => {
  const manifest = {
    contributes: {
      themes: [
        {
          label: "Dracula Theme",
          uiTheme: "vs-dark",
          path: "./theme/dracula.json",
        },
        {
          label: "Dracula Theme Soft",
          uiTheme: "vs-dark",
          path: "./theme/dracula-soft.json",
        },
      ],
    },
  };
  const vsix = zipSync({
    "extension/package.json": strToU8(JSON.stringify(manifest)),
    "extension/theme/dracula.json": strToU8(
      '{ "colors": { "editor.background": "#282a36", "button.background": "#ff79c6" } }',
    ),
    "extension/theme/dracula-soft.json": strToU8(
      '{ "colors": { "editor.background": "#2d2b3a", "button.background": "#ff79c6" } }',
    ),
  });
  const dracula: VsxExtension = {
    ...ext,
    displayName: "Dracula Theme Official",
    download: "https://cdn.test/dracula.vsix",
  };
  serve({ [dracula.download]: () => new Response(vsix) });
  expect(await fetchExtensionThemes(dracula)).toEqual({
    ok: true,
    family: {
      name: "Dracula Theme Official",
      variants: [
        {
          name: "Dracula Theme",
          appearance: "dark",
          colors: { background: "#282a36", accent: "#ff79c6" },
        },
        {
          name: "Dracula Theme Soft",
          appearance: "dark",
          colors: { background: "#2d2b3a", accent: "#ff79c6" },
        },
      ],
    },
  });
});

it("reports an extension with no color themes, and a failed download", async () => {
  serve({
    [ext.download]: () =>
      new Response(
        zipSync({ "extension/package.json": strToU8('{ "contributes": {} }') }),
      ),
  });
  expect(await fetchExtensionThemes(ext)).toEqual({
    ok: false,
    error: "Night contributes no color themes.",
  });
  serve({});
  expect(await fetchExtensionThemes(ext)).toEqual({
    ok: false,
    error: "Download failed: Open VSX answered 404.",
  });
});

const themeVsix = (extra: Record<string, Uint8Array>, path = "./theme.json") =>
  zipSync({
    "extension/package.json": strToU8(
      JSON.stringify({ contributes: { themes: [{ label: "Night", path }] } }),
    ),
    ...extra,
  });

it("refuses a download over 20 MB, by its content-length or its size", async () => {
  const error = "Night is over 20 MB, too large to import.";
  serve({
    [ext.download]: () =>
      new Response("{}", {
        headers: { "content-length": String(20 * 1024 * 1024 + 1) },
      }),
  });
  expect(await fetchExtensionThemes(ext)).toEqual({ ok: false, error });
  serve({
    [ext.download]: () => new Response(new Uint8Array(20 * 1024 * 1024 + 1)),
  });
  expect(await fetchExtensionThemes(ext)).toEqual({ ok: false, error });
});

it("reads only JSON entries of at most 4 MB", async () => {
  const big = `{ "colors": { "editor.background": "#101018" }, "pad": "${" ".repeat(4 * 1024 * 1024)}" }`;
  serve({
    [ext.download]: () =>
      new Response(themeVsix({ "extension/theme.json": strToU8(big) })),
  });
  expect(await fetchExtensionThemes(ext)).toEqual({
    ok: false,
    error: "extension/theme.json is over 4 MB, too large to read.",
  });
  serve({
    [ext.download]: () =>
      new Response(
        themeVsix(
          {
            "extension/theme.txt": strToU8(
              '{ "colors": { "editor.background": "#101018" } }',
            ),
          },
          "./theme.txt",
        ),
      ),
  });
  expect(await fetchExtensionThemes(ext)).toEqual({
    ok: false,
    error: "extension/theme.txt is missing from the extension.",
  });
});

it.each([
  ["../constructor", "constructor"],
  ["../../__proto__", "__proto__"],
])("reports a theme path of %j as missing", async (path, entry) => {
  serve({ [ext.download]: () => new Response(themeVsix({}, path)) });
  expect(await fetchExtensionThemes(ext)).toEqual({
    ok: false,
    error: `${entry} is missing from the extension.`,
  });
});
