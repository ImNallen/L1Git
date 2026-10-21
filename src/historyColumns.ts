import { useState } from "react";
import { z } from "zod";

export const COLUMNS_KEY = "l1git.columns.v1";

export const historyColumns = [
  { id: "author", label: "Author", width: 120 },
  { id: "date", label: "Date", width: 96 },
  { id: "sha", label: "SHA" },
  { id: "changes", label: "Changes", width: 160 },
] as const;
export type ColumnId = (typeof historyColumns)[number]["id"];

const columnId = z.custom<ColumnId>((value) =>
  historyColumns.some((column) => column.id === value),
);
const DEFAULT_COLUMNS: ReadonlySet<ColumnId> = new Set(["changes"]);

const columnsSchema = z.object({
  version: z.literal(1),
  visible: z.array(columnId),
});

const REF_WIDTH = 200;
const MESSAGE_MIN_WIDTH = 260;
const CROWDED_MESSAGE_MIN_WIDTH = 160;
// JetBrains Mono advances 0.6em per character, and .sha-cell sets it at 11px with 8px of right padding.
const SHA_CHAR_WIDTH = 6.6;
const SHA_PADDING = 8;

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
      ? Math.ceil(shaLength * SHA_CHAR_WIDTH) + SHA_PADDING
      : column.width,
  );
  return {
    columns,
    template: [
      `${REF_WIDTH}px`,
      `${graphWidth}px`,
      `minmax(${message}px, 1fr)`,
      ...widths.map((width) => `${width}px`),
    ].join(" "),
    minWidth: widths.reduce(
      (total, width) => total + width,
      REF_WIDTH + graphWidth + message,
    ),
  };
}

export function restoreColumns(
  storage: Pick<Storage, "getItem">,
): ReadonlySet<ColumnId> {
  try {
    const saved = storage.getItem(COLUMNS_KEY);
    if (saved === null) return DEFAULT_COLUMNS;
    return new Set(columnsSchema.parse(JSON.parse(saved)).visible);
  } catch {
    return DEFAULT_COLUMNS;
  }
}

const unsaved =
  "History columns changed for this session. Could not save them.";

export function persistColumns(
  storage: Pick<Storage, "setItem">,
  visible: ReadonlySet<ColumnId>,
): string | null {
  try {
    storage.setItem(
      COLUMNS_KEY,
      JSON.stringify({ version: 1, visible: [...visible] }),
    );
    return null;
  } catch {
    return unsaved;
  }
}

export function useHistoryColumns() {
  const [visible, setVisible] = useState(() => {
    try {
      return restoreColumns(localStorage);
    } catch {
      return DEFAULT_COLUMNS;
    }
  });
  const [persistenceError, setPersistenceError] = useState<string | null>(null);

  function toggle(id: ColumnId) {
    const next = new Set(visible);
    if (!next.delete(id)) next.add(id);
    setVisible(next);
    try {
      setPersistenceError(persistColumns(localStorage, next));
    } catch {
      setPersistenceError(unsaved);
    }
  }

  return { visible, toggle, persistenceError };
}
