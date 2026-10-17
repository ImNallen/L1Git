import { useEffect, useLayoutEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const storageKey = "l1git.appearance";
const systemQuery = "(prefers-color-scheme: dark)";
let nativeWrites = Promise.resolve();

export function parseThemePreference(value: unknown): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

export function resolveTheme(
  preference: ThemePreference,
  systemDark: boolean,
): ResolvedTheme {
  return preference === "system" ? (systemDark ? "dark" : "light") : preference;
}

function applyTheme(theme: ResolvedTheme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  const canvas = getComputedStyle(document.documentElement)
    .getPropertyValue("--canvas")
    .trim();
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", canvas);
  return canvas;
}

export function initializeAppearance(): ThemePreference {
  let preference: ThemePreference = "system";
  try {
    preference = parseThemePreference(localStorage.getItem(storageKey));
  } catch {}
  applyTheme(resolveTheme(preference, window.matchMedia(systemQuery).matches));
  return preference;
}

export function useAppearance(initial: ThemePreference) {
  const [preference, setPreferenceState] = useState(initial);
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia(systemQuery).matches,
  );
  const [persistenceError, setPersistenceError] = useState<string | null>(null);
  const [nativeError, setNativeError] = useState<string | null>(null);
  const resolvedTheme = resolveTheme(preference, systemDark);

  useEffect(() => {
    const media = window.matchMedia(systemQuery);
    const update = () => setSystemDark(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useLayoutEffect(() => {
    const canvas = applyTheme(resolvedTheme);
    if (!isTauri()) return;
    let active = true;
    nativeWrites = nativeWrites
      .then(async () => {
        if (!active) return;
        const nativeWindow = getCurrentWindow();
        await nativeWindow.setTheme(
          preference === "system" ? null : preference,
        );
        if (active && preference === "system") {
          setSystemDark(window.matchMedia(systemQuery).matches);
        }
        await nativeWindow.setBackgroundColor(canvas);
        await getCurrentWebview().setBackgroundColor(canvas);
        if (active) setNativeError(null);
      })
      .catch(() => {
        if (active)
          setNativeError("Could not update the native window appearance.");
      });
    return () => {
      active = false;
    };
  }, [preference, resolvedTheme]);

  function setPreference(next: ThemePreference) {
    setPreferenceState(next);
    setSystemDark(window.matchMedia(systemQuery).matches);
    try {
      localStorage.setItem(storageKey, next);
      setPersistenceError(null);
    } catch {
      setPersistenceError("Theme changed for this session. Could not save it.");
    }
  }

  return {
    preference,
    resolvedTheme,
    setPreference,
    persistenceError,
    nativeError,
  };
}
