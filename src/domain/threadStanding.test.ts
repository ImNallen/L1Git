import { describe, expect, it } from "vitest";
import type { ReviewThread } from "./pullRequest";
import { standing, threadsView } from "./threadStanding";
import type { Standing } from "./threadStanding";

const at = (hour: number) =>
  `2026-11-02T${String(hour).padStart(2, "0")}:00:00Z`;

function thread(
  id: string,
  said: readonly (string | null)[],
  fields: Partial<ReviewThread> = {},
  total = said.length,
): ReviewThread {
  return {
    id,
    review: null,
    path: "src/a.ts",
    line: 10,
    startLine: null,
    originalLine: 10,
    originalStartLine: null,
    side: "right",
    outdated: false,
    resolved: false,
    hunk: "",
    comments: {
      items: said.map((by, index) => ({
        id: `${id}-${index}`,
        body: `Comment ${index} by ${by}`,
        by,
        at: at(index + 1),
      })),
      total,
    },
    can: { reply: true, resolve: true, unresolve: false },
    ...fields,
  };
}

describe("standing", () => {
  it.each<[string, ReviewThread, Standing]>([
    ["nobody answered yet", thread("a", ["sara"]), "open"],
    ["the viewer spoke last", thread("a", ["sara", "octo"]), "open"],
    [
      "the last reply answers the viewer",
      thread("a", ["octo", "maja"]),
      "waitingOnYou",
    ],
    [
      "logins differ only in case",
      thread("a", ["Octo", "maja"]),
      "waitingOnYou",
    ],
    [
      "the viewer spoke earlier",
      thread("a", ["sara", "octo", "maja", "sara"]),
      "waitingOnYou",
    ],
    ["a deleted account answered", thread("a", ["octo", null]), "waitingOnYou"],
    ["the viewer never spoke", thread("a", ["sara", "maja"]), "open"],
    ["only the viewer spoke", thread("a", ["octo"]), "open"],
    ["no comment was read", thread("a", []), "open"],
    [
      "GitHub left out who spoke last",
      thread("a", ["octo", "maja"], {}, 60),
      "open",
    ],
    ["outdated", thread("a", ["sara"], { outdated: true }), "outdated"],
    [
      "outdated and waiting",
      thread("a", ["octo", "maja"], { outdated: true }),
      "waitingOnYou",
    ],
    ["resolved", thread("a", ["octo", "maja"], { resolved: true }), "resolved"],
    [
      "resolved and outdated",
      thread("a", ["sara"], { resolved: true, outdated: true }),
      "resolved",
    ],
  ])("%s", (_, given, expected) => {
    expect(standing(given, "octo")).toBe(expected);
  });
});

describe("threadsView", () => {
  const threads = [
    thread("open", ["sara"], { path: "src/b.ts", line: 30 }),
    thread("waiting", ["octo", "maja"], { path: "src/b.ts", line: 4 }),
    thread("old", ["sara", "maja"], {
      path: "crates/c.rs",
      line: null,
      outdated: true,
    }),
    thread("done", ["sara"], { path: "src/b.ts", resolved: true }),
    thread("done2", ["sara"], { path: "src/a.ts", resolved: true }),
  ];
  const ids = (view: ReturnType<typeof threadsView>) =>
    view.groups.map(({ path, rows }) => [
      path,
      rows.map(({ thread }) => thread.id),
    ]);

  it("counts each filter, with open counting every thread that isn't resolved", () => {
    expect(threadsView(threads, "octo", "open", new Set()).counts).toEqual({
      open: 3,
      waitingOnYou: 1,
      outdated: 1,
      resolved: 2,
    });
  });

  it("groups by file and orders by line, and hides the resolved ones behind a count", () => {
    const view = threadsView(threads, "octo", "open", new Set());
    expect(ids(view)).toEqual([
      ["crates/c.rs", ["old"]],
      ["src/b.ts", ["waiting", "open"]],
    ]);
    expect(view.hidden).toBe(2);
  });

  it.each([
    ["waitingOnYou", [["src/b.ts", ["waiting"]]]],
    ["outdated", [["crates/c.rs", ["old"]]]],
    [
      "resolved",
      [
        ["src/a.ts", ["done2"]],
        ["src/b.ts", ["done"]],
      ],
    ],
  ] as const)("shows only %s", (filter, expected) => {
    const view = threadsView(threads, "octo", filter, new Set());
    expect(ids(view)).toEqual(expected);
    expect(view.hidden).toBe(0);
  });

  it("keeps a thread acted on where it was, whatever it became", () => {
    const view = threadsView(
      threads,
      "octo",
      "waitingOnYou",
      new Set(["done"]),
    );
    expect(ids(view)).toEqual([["src/b.ts", ["waiting", "done"]]]);
    expect(view.groups[0]?.rows[1]?.standing).toBe("resolved");
  });

  it("says where, who began, how many answered, and when it last moved", () => {
    const [row] = threadsView(
      [
        thread(
          "range",
          ["sara", "octo", "maja"],
          { line: 102, startLine: 100 },
          8,
        ),
      ],
      "octo",
      "open",
      new Set(),
    ).groups[0]!.rows;
    expect(row).toMatchObject({
      place: ":100–102",
      by: "sara",
      words: "Comment 0 by sara",
      replies: 7,
      at: at(3),
    });
  });

  it.each([
    [{ line: 10, startLine: null }, ":10"],
    [{ line: 12, startLine: 12 }, ":12"],
    [{ line: null, originalLine: 7, originalStartLine: 5 }, ":5–7"],
    [{ line: null, originalLine: null }, "File"],
  ])("places %o at %s", (fields, place) => {
    const [row] = threadsView(
      [thread("a", ["sara"], fields)],
      "octo",
      "open",
      new Set(),
    ).groups[0]!.rows;
    expect(row?.place).toBe(place);
  });
});
