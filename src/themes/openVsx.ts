import { unzipSync } from "fflate";
import {
  asVsCodeTheme,
  isObject,
  mergeVsCodeThemes,
  readJsonc,
  vsCodeThemeToDraft,
  type ImportResult,
  type Parsed,
  type VsCodeTheme,
} from "./importers";

export type VsxExtension = {
  id: string;
  displayName: string;
  publisher: string;
  description: string;
  downloadCount: number;
  download: string;
};

const API = "https://open-vsx.org/api/-/search";
const MB = 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 20 * MB;
const MAX_ENTRY_BYTES = 4 * MB;

const text = (v: unknown) => (typeof v === "string" ? v : "");

function asExtension(raw: unknown): VsxExtension | null {
  if (!isObject(raw) || !isObject(raw.files)) return null;
  const [namespace, name, download] = [
    text(raw.namespace),
    text(raw.name),
    text(raw.files.download),
  ];
  if (!namespace || !name || !download) return null;
  return {
    id: `${namespace}.${name}`,
    displayName: text(raw.displayName) || name,
    publisher: namespace,
    description: text(raw.description),
    downloadCount:
      typeof raw.downloadCount === "number" ? raw.downloadCount : 0,
    download,
  };
}

export async function searchThemes(
  query: string,
  signal?: AbortSignal,
): Promise<VsxExtension[]> {
  const params = new URLSearchParams({
    query,
    category: "Themes",
    size: "20",
    sortBy: "downloadCount",
    sortOrder: "desc",
  });
  const res = await fetch(`${API}?${params}`, { signal });
  if (!res.ok) throw new Error(`Open VSX answered ${res.status}.`);
  const body: unknown = await res.json();
  const extensions =
    isObject(body) && Array.isArray(body.extensions) ? body.extensions : [];
  return extensions.flatMap((e) => asExtension(e) ?? []);
}

function resolve(dir: string, relative: string): string {
  const parts = dir.split("/").filter(Boolean);
  for (const part of relative.split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return parts.join("/");
}

const dirOf = (path: string) => path.slice(0, path.lastIndexOf("/") + 1);

export async function fetchExtensionThemes(
  ext: VsxExtension,
  signal?: AbortSignal,
): Promise<ImportResult> {
  const res = await fetch(ext.download, { signal });
  if (!res.ok)
    return {
      ok: false,
      error: `Download failed: Open VSX answered ${res.status}.`,
    };
  const tooBig = {
    ok: false,
    error: `${ext.displayName} is over ${MAX_DOWNLOAD_BYTES / MB} MB, too large to import.`,
  } as const;
  if (Number(res.headers.get("content-length")) > MAX_DOWNLOAD_BYTES)
    return tooBig;
  const vsix = new Uint8Array(await res.arrayBuffer());
  if (vsix.byteLength > MAX_DOWNLOAD_BYTES) return tooBig;
  const oversized = new Set<string>();
  const files = unzipSync(vsix, {
    filter: ({ name, originalSize }) => {
      if (!/\.jsonc?$/i.test(name)) return false;
      if (originalSize <= MAX_ENTRY_BYTES) return true;
      oversized.add(name);
      return false;
    },
  });
  const decoder = new TextDecoder();
  const read = (path: string): Parsed<unknown> => {
    if (oversized.has(path))
      return {
        ok: false,
        error: `${path} is over ${MAX_ENTRY_BYTES / MB} MB, too large to read.`,
      };
    const bytes = Object.hasOwn(files, path) ? files[path] : undefined;
    return bytes
      ? readJsonc(decoder.decode(bytes))
      : { ok: false, error: `${path} is missing from the extension.` };
  };
  const load = (path: string, depth = 0): Parsed<VsCodeTheme> => {
    const json = read(path);
    if (!json.ok) return json;
    const theme = asVsCodeTheme(json.value);
    if (!theme) return { ok: false, error: `${path} is not a color theme.` };
    if (!theme.include || depth > 4) return { ok: true, value: theme };
    const parent = load(resolve(dirOf(path), theme.include), depth + 1);
    return parent.ok
      ? { ok: true, value: mergeVsCodeThemes(parent.value, theme) }
      : parent;
  };

  const manifest = read("extension/package.json");
  const contributes =
    manifest.ok &&
    isObject(manifest.value) &&
    isObject(manifest.value.contributes)
      ? manifest.value.contributes.themes
      : undefined;
  const entries = Array.isArray(contributes)
    ? contributes.filter(isObject)
    : [];
  const errors: string[] = [];
  const variants = entries.flatMap((entry) => {
    const loaded = load(resolve("extension", text(entry.path)));
    if (!loaded.ok) {
      errors.push(loaded.error);
      return [];
    }
    const theme = loaded.value;
    const label = text(entry.label) || theme.name || ext.displayName;
    return [
      vsCodeThemeToDraft(
        { ...theme, name: label },
        ext.displayName,
        text(entry.uiTheme) || undefined,
      ),
    ];
  });
  if (variants.length > 0)
    return { ok: true, family: { name: ext.displayName, variants } };
  return {
    ok: false,
    error: errors[0] ?? `${ext.displayName} contributes no color themes.`,
  };
}
