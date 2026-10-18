import { describe, expect, it } from "vitest";
import {
  FETCH_SETTINGS_KEY,
  persistFetchSettings,
  restoreFetchSettings,
} from "./fetchSettings";

describe("stored fetch schedule", () => {
  it.each([
    ['{"version":1,"intervalMinutes":0}', 0],
    ['{"version":1,"intervalMinutes":5}', 5],
    ['{"version":1,"intervalMinutes":30}', 30],
    ['{"version":1,"intervalMinutes":60}', 60],
    [null, 15],
    ["", 15],
    ["15", 15],
    ["not json", 15],
    ['{"version":1,"intervalMinutes":7}', 15],
    ['{"version":1,"intervalMinutes":"5"}', 15],
    ['{"version":2,"intervalMinutes":5}', 15],
    ['{"intervalMinutes":5}', 15],
  ])("reads %j as every %i minutes", (stored, expected) => {
    expect(restoreFetchSettings({ getItem: () => stored })).toEqual({
      version: 1,
      intervalMinutes: expected,
    });
  });

  it("falls back to every 15 minutes when storage throws", () => {
    expect(
      restoreFetchSettings({
        getItem: () => {
          throw new Error("denied");
        },
      }),
    ).toEqual({ version: 1, intervalMinutes: 15 });
  });

  it("saves a versioned choice that restores unchanged", () => {
    const saved = new Map<string, string>();
    expect(
      persistFetchSettings(
        { setItem: (key, value) => void saved.set(key, value) },
        { version: 1, intervalMinutes: 5 },
      ),
    ).toBeNull();
    expect(saved.get(FETCH_SETTINGS_KEY)).toBe(
      '{"version":1,"intervalMinutes":5}',
    );
    expect(
      restoreFetchSettings({ getItem: (key) => saved.get(key) ?? null }),
    ).toEqual({ version: 1, intervalMinutes: 5 });
  });

  it("reports a write failure without throwing", () => {
    expect(
      persistFetchSettings(
        {
          setItem: () => {
            throw new Error("quota");
          },
        },
        { version: 1, intervalMinutes: 0 },
      ),
    ).toBe("Fetch schedule changed for this session. Could not save it.");
  });
});
