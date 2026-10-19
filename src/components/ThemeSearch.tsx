import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Download, LoaderCircle, Search } from "lucide-react";
import type { ThemeFamilyDraft } from "../themes/catalog";
import {
  fetchExtensionThemes,
  searchThemes,
  type VsxExtension,
} from "../themes/openVsx";

const POPULAR = ["Dracula", "Catppuccin", "Nord", "Tokyo Night"];
const DEBOUNCE_MS = 250;

type SearchState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "done"; query: string; results: VsxExtension[] }
  | { kind: "error"; message: string };

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

function useThemeSearch(query: string): SearchState {
  const [search, setSearch] = useState<SearchState>({ kind: "idle" });
  const trimmed = query.trim();
  useEffect(() => {
    if (!trimmed) return setSearch({ kind: "idle" });
    setSearch({ kind: "loading" });
    const abort = new AbortController();
    const timer = setTimeout(() => {
      searchThemes(trimmed, abort.signal).then(
        (results) => {
          if (!abort.signal.aborted)
            setSearch({ kind: "done", query: trimmed, results });
        },
        (error: unknown) => {
          if (!abort.signal.aborted)
            setSearch({ kind: "error", message: message(error) });
        },
      );
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [trimmed]);
  return search;
}

const downloads = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});

function Status({
  children,
  error = false,
}: {
  children: ReactNode;
  error?: boolean;
}) {
  return (
    <div
      className={`theme-search-status ${error ? "error" : ""}`}
      role={error ? "alert" : "status"}
    >
      {children}
    </div>
  );
}

type Props = { onImported: (family: ThemeFamilyDraft) => void };

export function ThemeSearch({ onImported }: Props) {
  const [query, setQuery] = useState("");
  const [importing, setImporting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const search = useThemeSearch(query);
  const download = useRef<AbortController | null>(null);
  useEffect(() => () => download.current?.abort(), []);

  async function pick(extension: VsxExtension) {
    const abort = new AbortController();
    download.current = abort;
    setImporting(extension.id);
    setError(null);
    try {
      const result = await fetchExtensionThemes(extension, abort.signal);
      if (abort.signal.aborted) return;
      if (!result.ok) return setError(result.error);
      onImported(result.family);
    } catch (caught) {
      if (!abort.signal.aborted)
        setError(
          `Couldn't import ${extension.displayName}: ${message(caught)}`,
        );
    } finally {
      if (!abort.signal.aborted) setImporting(null);
    }
  }

  return (
    <div className="theme-search">
      <label htmlFor="theme-search">Search community themes</label>
      <div className="theme-search-input">
        <Search size={14} />
        <input
          id="theme-search"
          autoFocus
          autoComplete="off"
          spellCheck={false}
          placeholder="Search Open VSX themes…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div className="theme-search-popular">
        <span>Popular</span>
        {POPULAR.map((name) => (
          <button key={name} type="button" onClick={() => setQuery(name)}>
            {name}
          </button>
        ))}
      </div>
      {search.kind === "loading" && (
        <Status>
          <LoaderCircle size={14} className="spin" />
          Searching Open VSX…
        </Status>
      )}
      {search.kind === "error" && (
        <Status error>Couldn't reach Open VSX: {search.message}</Status>
      )}
      {search.kind === "done" && search.results.length === 0 && (
        <Status>No themes match “{search.query}”.</Status>
      )}
      {search.kind === "done" && search.results.length > 0 && (
        <ul className="theme-search-results" aria-label="Open VSX themes">
          {search.results.map((extension) => (
            <li key={extension.id}>
              <button
                type="button"
                disabled={importing !== null}
                title={extension.description}
                onClick={() => void pick(extension)}
              >
                <span className="theme-search-name">
                  <strong>{extension.displayName}</strong>
                  <span>{extension.publisher}</span>
                </span>
                {importing === extension.id ? (
                  <LoaderCircle size={14} className="spin" />
                ) : (
                  <span className="theme-search-downloads">
                    <Download size={12} />
                    {downloads.format(extension.downloadCount)}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p className="theme-search-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
