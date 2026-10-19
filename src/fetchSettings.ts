import { useState } from "react";
import { z } from "zod";

export const FETCH_SETTINGS_KEY = "l1git.fetch.v1";
export const fetchIntervals = [0, 5, 15, 30, 60] as const;
export type FetchInterval = (typeof fetchIntervals)[number];
const fetchSettingsSchema = z.object({
  version: z.literal(1),
  intervalMinutes: z.literal(fetchIntervals),
});
export type FetchSettings = z.infer<typeof fetchSettingsSchema>;
export const defaultFetchSettings: FetchSettings = {
  version: 1,
  intervalMinutes: 15,
};

export function restoreFetchSettings(
  storage: Pick<Storage, "getItem">,
): FetchSettings {
  try {
    const saved = storage.getItem(FETCH_SETTINGS_KEY);
    if (saved === null) return defaultFetchSettings;
    return fetchSettingsSchema.parse(JSON.parse(saved));
  } catch {
    return defaultFetchSettings;
  }
}

const unsaved = "Fetch schedule changed for this session. Could not save it.";

export function persistFetchSettings(
  storage: Pick<Storage, "setItem">,
  settings: FetchSettings,
): string | null {
  try {
    storage.setItem(FETCH_SETTINGS_KEY, JSON.stringify(settings));
    return null;
  } catch {
    return unsaved;
  }
}

export function useFetchSettings() {
  const [settings, setSettings] = useState(() => {
    try {
      return restoreFetchSettings(localStorage);
    } catch {
      return defaultFetchSettings;
    }
  });
  const [persistenceError, setPersistenceError] = useState<string | null>(null);

  function setIntervalMinutes(intervalMinutes: FetchInterval) {
    const next: FetchSettings = { version: 1, intervalMinutes };
    setSettings(next);
    try {
      setPersistenceError(persistFetchSettings(localStorage, next));
    } catch {
      setPersistenceError(unsaved);
    }
  }

  return {
    intervalMinutes: settings.intervalMinutes,
    setIntervalMinutes,
    persistenceError,
  };
}
