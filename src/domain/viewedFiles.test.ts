import { describe, expect, it } from "vitest";
import type { RangeFile } from "./range";
import { oidSchema } from "./repository";
import {
  emptyRecord,
  markOf,
  nextUnviewed,
  pullName,
  viewedAmong,
  viewedRecordSchema,
  withChanges,
} from "./viewedFiles";
import type { MarkChange } from "./viewedFiles";

const oid = (digit: string) => oidSchema.parse(digit.repeat(40));
const file = (fields: Partial<RangeFile> = {}): RangeFile => ({
  path: "src/a.ts",
  status: "M",
  from: null,
  similarity: null,
  added: 1,
  deleted: 1,
  oldBlob: oid("1"),
  newBlob: oid("2"),
  oldMode: "100644",
  newMode: "100644",
  submodule: false,
  ...fields,
});
const change = (
  mark: string,
  pull = "octo/pin#1",
  isViewed = true,
): MarkChange => ({ pull, mark, isViewed });

describe("markOf", () => {
  it("is another for whatever changes the file", () => {
    const marks = [
      file(),
      file({ path: "src/b.ts" }),
      file({ oldBlob: oid("3") }),
      file({ newBlob: oid("3") }),
      file({ newMode: "100755" }),
      file({ oldMode: "100755" }),
      file({ status: "R", from: "src/old.ts" }),
      file({ status: "R", from: "src/older.ts" }),
      file({ status: "A", oldBlob: null, oldMode: null }),
      file({ status: "D", newBlob: null, newMode: null }),
      file({ oldBlob: null, newBlob: null, oldMode: null, newMode: null }),
      file({ status: "T", newMode: "120000" }),
      file({ submodule: true, oldMode: "160000", newMode: "160000" }),
    ].map(markOf);
    expect(new Set(marks).size).toBe(marks.length);
  });

  it("is the same for what others did", () => {
    expect(markOf(file({ added: 9, similarity: 3 }))).toBe(markOf(file()));
  });

  it("takes no two names for one", () => {
    const moved = (from: string, path: string) =>
      markOf(file({ status: "R", from, path }));
    expect(moved("a b", "c")).not.toBe(moved("a", "b c"));
    expect(moved("a", "b")).not.toBe(markOf(file({ path: "a b" })));
  });

  it("is short", () => {
    expect(markOf(file())).toBe(
      "1111111111111111 2222222222222222 100644 100644 src/a.ts",
    );
  });
});

it("names a pull request by its repository", () => {
  expect(pullName({ key: "octo/pin" }, 12)).toBe("octo/pin#12");
});

describe("withChanges", () => {
  it("keeps the marks of each pull request, the last used last", () => {
    const record = withChanges(emptyRecord, [
      change("a"),
      change("b", "octo/pin#2"),
      change("c"),
    ]);
    expect(record.pulls).toEqual([
      { pull: "octo/pin#2", marks: ["b"] },
      { pull: "octo/pin#1", marks: ["a", "c"] },
    ]);
    expect(viewedRecordSchema.parse(record)).toEqual(record);
    const without = withChanges(record, [
      change("a", "octo/pin#1", false),
      change("b", "octo/pin#2", false),
      change("gone", "octo/pin#3", false),
    ]);
    expect(without.pulls).toEqual([{ pull: "octo/pin#1", marks: ["c"] }]);
  });

  it("leaves what it was given alone", () => {
    const record = withChanges(emptyRecord, [change("a")]);
    withChanges(record, [change("b")]);
    expect(record.pulls).toEqual([{ pull: "octo/pin#1", marks: ["a"] }]);
    expect(emptyRecord.pulls).toEqual([]);
  });

  it("keeps the last 200 pull requests", () => {
    const record = withChanges(
      emptyRecord,
      Array.from({ length: 201 }, (_, number) =>
        change("a", `octo/pin#${number}`),
      ),
    );
    expect(record.pulls).toHaveLength(200);
    expect(record.pulls[0]?.pull).toBe("octo/pin#1");
    const used = withChanges(record, [change("b", "octo/pin#1")]);
    const more = withChanges(used, [change("a", "octo/pin#new")]);
    expect(more.pulls[0]?.pull, "the one that was used last stays").toBe(
      "octo/pin#3",
    );
    expect(more.pulls.map(({ pull }) => pull)).toContain("octo/pin#1");
  });

  it("keeps the newest 5,000 marks of one", () => {
    const [pull] = withChanges(
      emptyRecord,
      Array.from({ length: 5_001 }, (_, number) => change(`m${number}`)),
    ).pulls;
    expect(pull?.marks).toHaveLength(5_000);
    expect(pull?.marks[0]).toBe("m1");
  });

  it("drops the oldest when all come to too much", () => {
    const long = (number: number) => `${number}`.padEnd(300_000, "x");
    const { pulls } = withChanges(
      emptyRecord,
      Array.from({ length: 6 }, (_, number) =>
        change(long(number), `octo/pin#${Math.floor(number / 2)}`),
      ),
    );
    expect(
      pulls.map(({ pull, marks }) => [pull, marks.map((mark) => mark[0])]),
    ).toEqual([
      ["octo/pin#0", ["1"]],
      ["octo/pin#1", ["2", "3"]],
      ["octo/pin#2", ["4", "5"]],
    ]);
    const huge = withChanges(emptyRecord, [change("y".repeat(2_000_000))]);
    expect(huge.pulls).toEqual([]);
  });
});

describe("viewedAmong", () => {
  it("drops a mark when the file changes, and has it again when it goes back", () => {
    const record = withChanges(emptyRecord, [change(markOf(file()))]);
    const viewed = (of: RangeFile) =>
      viewedAmong([of], record, "octo/pin#1").has(of);
    expect(viewed(file())).toBe(true);
    expect(viewed(file({ newBlob: oid("3") }))).toBe(false);
    expect(viewed(file()), "another read of it").toBe(true);
    const of = file();
    expect(viewedAmong([of], record, "octo/pin#2").has(of)).toBe(false);
  });
});

describe("nextUnviewed", () => {
  const files = ["a", "b", "c", "d"].map((path) => file({ path }));
  it.each([
    { viewed: [], at: 0, next: 1 },
    { viewed: [1], at: 0, next: 2 },
    { viewed: [], at: 3, next: 0 },
    { viewed: [0, 3], at: 2, next: 1 },
    { viewed: [0, 1, 3], at: 2, next: null },
    { viewed: [0, 1, 2, 3], at: 2, next: null },
    { viewed: [0, 2, 3], at: 3, next: 1 },
  ])("goes from $at to $next with $viewed viewed", ({ viewed, at, next }) => {
    const set = new Set(files.filter((_, place) => viewed.includes(place)));
    expect(nextUnviewed(files, set, at)).toBe(next);
  });
});
