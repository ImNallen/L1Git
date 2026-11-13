import { useState } from "react";
import { z } from "zod";
import { browserStorage, readStored, writeStored } from "./persisted";

export const COLUMNS_KEY = "l1git.columns.v1";

export const historyColumns = [
  { id: "author", label: "Author", width: 140 },
  { id: "date", label: "Age", width: 60 },
  { id: "sha", label: "Commit ID" },
  { id: "changes", label: "Changes", width: 202 },
] as const;
export type ColumnId = (typeof historyColumns)[number]["id"];

const columnId = z.custom<ColumnId>((value) =>
  historyColumns.some((column) => column.id === value),
);
const DEFAULT_COLUMNS: ReadonlySet<ColumnId> = new Set(
  historyColumns.map((column) => column.id),
);

const columnsSchema = z.object({
  version: z.literal(1),
  visible: z.array(columnId),
});

const MESSAGE_MIN_WIDTH = 260;
const CROWDED_MESSAGE_MIN_WIDTH = 160;
const SHA_CHAR_WIDTH = 7.2;
const SHA_PADDING = 8 + 1;

export function columnLayout(
  graphWidth: number,
  visible: ReadonlySet<ColumnId>,
  shaLength: number,
) {
  const columns = historyColumns.filter((column) => visible.has(column.id));
  const message = columns.some((column) => column.id !== "changes")
    ? CROWDED_MESSAGE_MIN_WIDTH
    : MESSAGE_MIN_WIDTH;
  const widths = columns.map((column) =>
    column.id === "sha"
      ? Math.max(100, Math.ceil(shaLength * SHA_CHAR_WIDTH) + SHA_PADDING)
      : column.width,
  );
  return {
    columns,
    template: [
      `${graphWidth}px`,
      `minmax(${message}px, 1fr)`,
      ...widths.map((width) => `${width}px`),
    ].join(" "),
    minWidth: widths.reduce(
      (total, width) => total + width,
      graphWidth + message,
    ),
  };
}

export function restoreColumns(
  storage: Pick<Storage, "getItem"> | null,
): ReadonlySet<ColumnId> {
  const saved = readStored(storage, COLUMNS_KEY, columnsSchema);
  return saved === null ? DEFAULT_COLUMNS : new Set(saved.visible);
}

export function persistColumns(
  storage: Pick<Storage, "setItem"> | null,
  visible: ReadonlySet<ColumnId>,
): string | null {
  return writeStored(
    storage,
    COLUMNS_KEY,
    { version: 1, visible: [...visible] },
    "History columns changed for this session. Could not save them.",
  );
}

export function useHistoryColumns() {
  const [visible, setVisible] = useState(() =>
    restoreColumns(browserStorage()),
  );
  const [persistenceError, setPersistenceError] = useState<string | null>(null);

  function toggle(id: ColumnId) {
    const next = new Set(visible);
    if (!next.delete(id)) next.add(id);
    setVisible(next);
    setPersistenceError(persistColumns(browserStorage(), next));
  }

  return { visible, toggle, persistenceError };
}
