import { useState } from "react";
import { z } from "zod";
import { browserStorage, readStored, writeStored } from "./persisted";

export const FETCH_SETTINGS_KEY = "l1git.fetch.v1";
export const fetchIntervals = [0, 5, 15, 30, 60] as const;
export type FetchInterval = (typeof fetchIntervals)[number];
const fetchSettingsSchema = z.object({
  version: z.literal(1),
  intervalMinutes: z.literal(fetchIntervals),
});
type FetchSettings = z.infer<typeof fetchSettingsSchema>;
const defaultFetchSettings: FetchSettings = {
  version: 1,
  intervalMinutes: 15,
};

export function restoreFetchSettings(
  storage: Pick<Storage, "getItem"> | null,
): FetchSettings {
  return (
    readStored(storage, FETCH_SETTINGS_KEY, fetchSettingsSchema) ??
    defaultFetchSettings
  );
}

export function persistFetchSettings(
  storage: Pick<Storage, "setItem"> | null,
  settings: FetchSettings,
): string | null {
  return writeStored(
    storage,
    FETCH_SETTINGS_KEY,
    settings,
    "Fetch schedule changed for this session. Could not save it.",
  );
}

export function useFetchSettings() {
  const [settings, setSettings] = useState(() =>
    restoreFetchSettings(browserStorage()),
  );
  const [persistenceError, setPersistenceError] = useState<string | null>(null);

  function setIntervalMinutes(intervalMinutes: FetchInterval) {
    const next: FetchSettings = { version: 1, intervalMinutes };
    setSettings(next);
    setPersistenceError(persistFetchSettings(browserStorage(), next));
  }

  return {
    intervalMinutes: settings.intervalMinutes,
    setIntervalMinutes,
    persistenceError,
  };
}
