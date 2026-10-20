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
  it("lays out only the Changes column by default", () => {
    const layout = columnLayout(58, new Set<ColumnId>(["changes"]));
    expect(layout.template).toBe("200px 58px minmax(260px, 1fr) 160px");
    expect(layout.minWidth).toBe(678);
  });

  it("lays out every column in table order whatever order they were checked", () => {
    const layout = columnLayout(
      106,
      new Set<ColumnId>(["changes", "sha", "author", "date"]),
    );
    expect(layout.template).toBe(
      "200px 106px minmax(160px, 1fr) 120px 96px 64px 160px",
    );
    expect(layout.minWidth).toBe(906);
    expect(layout.columns.map((column) => column.label)).toEqual([
      "Author",
      "Date",
      "SHA",
      "Changes",
    ]);
  });

  it("narrows the message minimum once a column besides Changes is on", () => {
    const layout = columnLayout(82, new Set<ColumnId>(["author"]));
    expect(layout.template).toBe("200px 82px minmax(160px, 1fr) 120px");
    expect(layout.minWidth).toBe(562);
  });

  it("keeps only the fixed columns when every optional column is off", () => {
    expect(columnLayout(48, new Set()).template).toBe(
      "200px 48px minmax(260px, 1fr)",
    );
  });
});

describe("stored history columns", () => {
  it.each([
    [null, ["changes"]],
    ["not json", ["changes"]],
    ['{"version":2,"visible":["date"]}', ["changes"]],
    ['{"version":1,"visible":["date","subject"]}', ["changes"]],
    ['{"version":1,"visible":"date"}', ["changes"]],
    ['{"version":1,"visible":[]}', []],
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
