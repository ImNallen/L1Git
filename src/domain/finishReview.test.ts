import { describe, expect, it } from "vitest";
import {
  byHead,
  eventsFor,
  heldBack,
  remindersOf,
  reviewOf,
  unresolvedText,
} from "./finishReview";
import type { ReviewEvent } from "./finishReview";
import type { PullRequest, ReviewThread } from "./pullRequest";
import type { RangeFile } from "./range";
import { oidSchema } from "./repository";

const head = oidSchema.parse("1".repeat(40));
const older = oidSchema.parse("0".repeat(40));

it("sends only what was written against the head GitHub has", () => {
  const drafts = [
    { id: "now", head },
    { id: "then", head: older },
  ];
  expect(byHead(drafts, head)).toEqual({
    current: [{ id: "now", head }],
    older: [{ id: "then", head: older }],
  });
});

it("offers a comment only on your own pull request", () => {
  expect(eventsFor({ viewerIsAuthor: true })).toEqual(["comment"]);
  expect(eventsFor({ viewerIsAuthor: false })).toEqual([
    "comment",
    "approve",
    "requestChanges",
  ]);
});

describe("heldBack", () => {
  it.each<[ReviewEvent, string, number, string | null]>([
    ["comment", "", 1, null],
    ["comment", "Thanks", 0, null],
    ["comment", " \n", 0, "Write a summary or a comment on lines first."],
    ["approve", "", 0, null],
    [
      "requestChanges",
      "",
      3,
      "Request changes needs a summary, as GitHub requires.",
    ],
    ["requestChanges", "Split it", 0, null],
    [
      "approve",
      "x".repeat(65_537),
      0,
      "GitHub takes at most 65,536 characters in a summary.",
    ],
  ])("%s with %j and %i comments", (event, summary, comments, expected) => {
    expect(heldBack({ event, summary, comments })).toBe(expected);
  });
});

it("makes one review of the summary and every pending comment", () => {
  const pull = {
    id: "PR_1",
    head: { oid: head },
  } as unknown as Pick<PullRequest, "id" | "head">;
  const anchor = {
    kind: "line" as const,
    path: "a.ts",
    side: "right" as const,
    line: 12,
    start: { side: "right" as const, line: 10 },
  };
  expect(
    reviewOf(pull, "approve", "  ", [{ anchor, head, text: "Why?" }]),
  ).toEqual({
    kind: "submitReview",
    pull: "PR_1",
    commit: head,
    event: "approve",
    body: "",
    threads: [
      {
        lines: { path: "a.ts", side: "right", line: 12, start: anchor.start },
        body: "Why?",
      },
    ],
  });
});

it("reminds of files not viewed and threads not resolved", () => {
  const files = [{ path: "a" }, { path: "b" }] as unknown as RangeFile[];
  const threads = [
    { id: "open", resolved: false },
    { id: "done", resolved: true },
  ] as unknown as ReviewThread[];
  const shown = remindersOf({ files, viewed: new Set([files[0]!]), threads });
  expect(shown.notViewed).toBe(1);
  expect(shown.of).toBe(2);
  expect(shown.unresolved.map(({ id }) => id)).toEqual(["open"]);
});

describe("unresolvedText", () => {
  const thread = (
    by: string | null,
    line: number | null,
    originalLine: number | null = line,
  ) =>
    ({
      path: "src/views/ReplayPanel.tsx",
      line,
      originalLine,
      comments: { items: [{ by }], total: 1 },
    }) as unknown as ReviewThread;
  it.each<[ReviewThread, string]>([
    [thread("octo", 92), "Your thread on ReplayPanel.tsx:92 is unresolved"],
    [thread("OCTO", 92), "Your thread on ReplayPanel.tsx:92 is unresolved"],
    [thread("sara", 7), "sara's thread on ReplayPanel.tsx:7 is unresolved"],
    [thread(null, 7), "ghost's thread on ReplayPanel.tsx:7 is unresolved"],
    [
      thread("sara", null, 40),
      "sara's thread on ReplayPanel.tsx:40 is unresolved",
    ],
    [
      thread("sara", null, null),
      "sara's thread on ReplayPanel.tsx is unresolved",
    ],
  ])("names whose thread and where", (shown, text) => {
    expect(unresolvedText(shown, "octo")).toBe(text);
  });
});
