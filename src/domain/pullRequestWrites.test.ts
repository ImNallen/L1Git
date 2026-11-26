import { describe, expect, it } from "vitest";
import { at, page, pull } from "../test/pullRequests";
import { writeHandler } from "../test/fakeWrites";
import type { HostStatus } from "./host";
import { pullRequestSchema } from "./pullRequest";
import type { PullRequest, ReviewThread } from "./pullRequest";
import { landed } from "./pullRequestWrites";
import type { PullWrite } from "./pullRequestWrites";
import { oidSchema } from "./repository";

const head = oidSchema.parse("1".repeat(40));
const status: HostStatus = {
  revision: 1,
  github: {
    kind: "connected",
    login: "octo",
    api: "https://api.github.com/",
    method: "gh",
    access: "private",
    connectedAt: 1,
  },
  deviceSignIn: false,
  deviceCode: null,
};
const thread = (fields: Partial<ReviewThread> = {}): ReviewThread => ({
  id: "T_1",
  review: "R_1",
  path: "src/a.ts",
  line: 4,
  startLine: null,
  originalLine: 4,
  originalStartLine: null,
  side: "right",
  outdated: false,
  resolved: false,
  hunk: "",
  comments: page([{ id: "C_1", body: "Why?", by: "sara", at: at(1) }]),
  can: { reply: true, resolve: true, unresolve: false },
  ...fields,
});
const before = pullRequestSchema.parse({
  ...pull(1),
  threads: page([thread()]),
  pending: { kind: "review", id: "PRR_1", comments: page([]) },
});
const id = before.id;
const review = (
  before.pending as Extract<PullRequest["pending"], { kind: "review" }>
).id;
const lines = {
  path: "src/a.ts",
  side: "right",
  line: 4,
  start: null,
} as const;

/** What the fake GitHub makes of `write`, as the next read shows it. */
function after(write: PullWrite, from = before) {
  const details = new Map([["octo/pin#1", from]]);
  const written = writeHandler("octo", write, { status, details, writes: [] });
  expect(written.kind).toBe("done");
  return details.get("octo/pin#1")!;
}

const merged = pull(1, { state: { kind: "merged", at: at(3) } });
const writes: [PullWrite, PullRequest][] = [
  [
    { kind: "singleComment", pull: id, commit: head, lines, body: "Off?" },
    before,
  ],
  [
    {
      kind: "submitReview",
      pull: id,
      commit: head,
      event: "approve",
      body: "Ship it.",
      threads: [{ lines, body: "Nit." }],
    },
    before,
  ],
  [
    {
      kind: "submitPending",
      review,
      event: "comment",
      body: "",
    },
    before,
  ],
  [{ kind: "reply", thread: "T_1", body: "Fixed." }, before],
  [{ kind: "resolve", thread: "T_1" }, before],
  [
    { kind: "unresolve", thread: "T_1" },
    pull(1, { threads: page([thread({ resolved: true })]) }),
  ],
  [{ kind: "comment", pull: id, body: "Thanks!" }, before],
  [
    {
      kind: "merge",
      pull: id,
      expectedHead: head,
      method: "squash",
      headline: null,
      body: null,
    },
    before,
  ],
  [
    {
      kind: "deleteHeadBranch",
      pull: id,
      branch: "branch-1",
      expectedHead: head,
    },
    merged,
  ],
];

describe("landed", () => {
  const since = Date.parse(at(2));

  it.each(writes)("tells whether a read shows a $kind", (write, from) => {
    expect(landed(write, from, since, "octo")).toBe(false);
    expect(landed(write, after(write, from), since, "octo")).toBe(true);
  });

  it("finds words GitHub stored with other line endings and outer spaces", () => {
    const write = { kind: "comment", pull: id, body: "One\r\ntwo " } as const;
    const read = pull(1, {
      timeline: page([
        { kind: "comment", id: "K_1", body: "One\ntwo", by: "Octo", at: at(2) },
      ]),
    });
    expect(landed(write, read, since, "octo")).toBe(true);
  });

  it("never takes someone else's words, or the viewer's from before, for the write", () => {
    const write = { kind: "reply", thread: "T_1", body: "Why?" } as const;
    const said = (by: string, hour: number) =>
      pull(1, {
        threads: page([
          thread({
            comments: page([{ id: "C", body: "Why?", by, at: at(hour) }]),
          }),
        ]),
      });
    expect(landed(write, said("sara", 2), since, "octo")).toBe(false);
    expect(landed(write, said("octo", 1), since, "octo")).toBe(false);
    expect(landed(write, said("octo", 2), since, "octo")).toBe(true);
  });

  it("cannot tell from a read GitHub cut short or left threads out of", () => {
    const reply = { kind: "reply", thread: "T_1", body: "Fixed." } as const;
    const cut = pull(1, {
      threads: page([thread({ comments: page(thread().comments.items, 51) })]),
    });
    expect(landed(reply, cut, since, "octo")).toBeNull();
    const withheld = pull(1, { threads: null });
    expect(landed(reply, withheld, since, "octo")).toBeNull();
    expect(
      landed({ kind: "resolve", thread: "T_1" }, withheld, since, "octo"),
    ).toBeNull();
    const single = writes[0]![0];
    expect(landed(single, withheld, since, "octo")).toBeNull();
    const pending = writes[2]![0];
    const unread = pull(1, { pending: { kind: "unknown" } });
    expect(landed(pending, unread, since, "octo")).toBeNull();
  });
});
