import type { z } from "zod";

/** Reading the `localStorage` global throws where the webview denies storage. */
export function browserStorage(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

/** The saved value, or null when it is missing, unreadable, or invalid. */
export function readStored<T>(
  storage: Pick<Storage, "getItem"> | null,
  key: string,
  schema: z.ZodType<T>,
): T | null {
  try {
    const saved = storage?.getItem(key) ?? null;
    return saved === null ? null : schema.parse(JSON.parse(saved));
  } catch {
    return null;
  }
}

/** Null once saved, else the message to show. */
export function writeStored(
  storage: Pick<Storage, "setItem"> | null,
  key: string,
  value: unknown,
  unsavedMessage: string,
): string | null {
  if (storage === null) return unsavedMessage;
  try {
    storage.setItem(key, JSON.stringify(value));
    return null;
  } catch {
    return unsavedMessage;
  }
}
