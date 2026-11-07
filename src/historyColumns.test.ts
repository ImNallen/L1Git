import { describe, expect, it } from "vitest";
import {
  COLUMNS_KEY,
  columnLayout,
  historyColumns,
  persistColumns,
  restoreColumns,
} from "./historyColumns";
import type { ColumnId } from "./historyColumns";

describe("history column layout", () => {
  it("shows every metadata column for new preferences", () => {
    const layout = columnLayout(58, restoreColumns({ getItem: () => null }), 7);
    expect(layout.template).toBe(
      "58px minmax(160px, 1fr) 140px 60px 100px 202px",
    );
    expect(layout.minWidth).toBe(720);
  });

  it("keeps the wider message minimum when only Changes is on", () => {
    const layout = columnLayout(58, new Set<ColumnId>(["changes"]), 7);
    expect(layout.template).toBe("58px minmax(260px, 1fr) 202px");
    expect(layout.minWidth).toBe(520);
  });

  it("lays out every column in table order whatever order they were checked", () => {
    const layout = columnLayout(
      106,
      new Set<ColumnId>(["changes", "sha", "author", "date"]),
      7,
    );
    expect(layout.template).toBe(
      "106px minmax(160px, 1fr) 140px 60px 100px 202px",
    );
    expect(layout.minWidth).toBe(768);
    expect(layout.columns.map((column) => column.label)).toEqual([
      "Author",
      "Age",
      "Commit ID",
      "Changes",
    ]);
  });

  it.each([
    [8, "100px", 318],
    [10, "100px", 318],
    [16, "115px", 333],
  ])("fits a %i-character commit ID", (length, width, minWidth) => {
    const layout = columnLayout(58, new Set<ColumnId>(["sha"]), length);
    expect(layout.template).toBe(`58px minmax(160px, 1fr) ${width}`);
    expect(layout.minWidth).toBe(minWidth);
  });

  it("narrows the message minimum once a column besides Changes is on", () => {
    const layout = columnLayout(82, new Set<ColumnId>(["author"]), 7);
    expect(layout.template).toBe("82px minmax(160px, 1fr) 140px");
    expect(layout.minWidth).toBe(382);
  });

  it("keeps only the fixed columns when every optional column is off", () => {
    expect(columnLayout(48, new Set(), 7).template).toBe(
      "48px minmax(260px, 1fr)",
    );
  });
});

describe("stored history columns", () => {
  it.each([
    [null, ["author", "date", "sha", "changes"]],
    ["not json", ["author", "date", "sha", "changes"]],
    ['{"version":2,"visible":["date"]}', ["author", "date", "sha", "changes"]],
    [
      '{"version":1,"visible":["date","subject"]}',
      ["author", "date", "sha", "changes"],
    ],
    ['{"version":1,"visible":"date"}', ["author", "date", "sha", "changes"]],
    ['{"version":1,"visible":[]}', []],
    ['{"version":1,"visible":["changes"]}', ["changes"]],
    ['{"version":1,"visible":["sha","date"]}', ["sha", "date"]],
  ])("reads %j as %j", (stored, expected) => {
    expect([...restoreColumns({ getItem: () => stored })]).toEqual(expected);
  });

  it("restores every column the table lists", () => {
    const stored = JSON.stringify({
      version: 1,
      visible: historyColumns.map((column) => column.id),
    });
    expect([...restoreColumns({ getItem: () => stored })]).toEqual([
      "author",
      "date",
      "sha",
      "changes",
    ]);
  });

  it("saves a versioned list that restores unchanged", () => {
    const saved = new Map<string, string>();
    expect(
      persistColumns(
        { setItem: (key, value) => void saved.set(key, value) },
        new Set<ColumnId>(["date", "changes"]),
      ),
    ).toBeNull();
    expect(saved.get(COLUMNS_KEY)).toBe(
      '{"version":1,"visible":["date","changes"]}',
    );
    expect([
      ...restoreColumns({ getItem: (key) => saved.get(key) ?? null }),
    ]).toEqual(["date", "changes"]);
  });

  it("reports a failed save", () => {
    expect(
      persistColumns(
        {
          setItem: () => {
            throw new Error("quota");
          },
        },
        new Set<ColumnId>(["sha"]),
      ),
    ).toBe("History columns changed for this session. Could not save them.");
  });
});
