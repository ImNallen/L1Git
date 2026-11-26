import { z } from "zod";
import {
  emptyRecord,
  viewedRecordSchema,
  withChanges,
} from "./domain/viewedFiles";
import type { MarkChange, ViewedRecord } from "./domain/viewedFiles";
import { readStored, writeStored } from "./persisted";

const VIEWED_KEY = "l1git.viewed.v1";
/** What a newer version of the app wrote, which is not to be lost. */
const newerSchema = z.object({ version: z.number().gt(1) });
const unsavedMessage =
  "Viewed files changed for this session. Could not save them.";

/** Which files were viewed. It is on this computer only, and for this session alone when it can't be saved. */
export function createViewedFiles(
  storage: Pick<Storage, "getItem" | "setItem"> | null,
) {
  const listeners = new Set<() => void>();
  let unsaved: MarkChange[] = [];
  /** Another window may have written since. */
  const latest = () =>
    withChanges(
      readStored(storage, VIEWED_KEY, viewedRecordSchema) ?? emptyRecord,
      unsaved,
    );
  let record: ViewedRecord = emptyRecord;

  function put(next: ViewedRecord) {
    record = next;
    listeners.forEach((listener) => listener());
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    read: () => record,
    look: () => put(latest()),
    /** Null once saved, else the message to show. */
    mark(change: MarkChange): string | null {
      unsaved = [
        ...unsaved.filter(
          ({ pull, mark }) => pull !== change.pull || mark !== change.mark,
        ),
        change,
      ];
      const next = latest();
      const isNewer = readStored(storage, VIEWED_KEY, newerSchema) !== null;
      const error = isNewer
        ? unsavedMessage
        : writeStored(storage, VIEWED_KEY, next, unsavedMessage);
      if (error === null) unsaved = [];
      put(next);
      return error;
    },
  };
}
